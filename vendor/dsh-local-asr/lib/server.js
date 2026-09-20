/**
 * 本地 ASR 服务：OpenAI 兼容 /v1/audio/transcriptions（multipart），底层 spawn whisper.cpp。
 *
 * 设计要点：
 *  - 只监听 127.0.0.1：这是给本机 dsh-voice 用的，绝不能暴露到局域网
 *  - 零依赖：multipart 解析手写（Buffer 切边界，二进制安全），不引第三方包
 *  - 音频格式：whisper.cpp 内建 miniaudio（mp3/flac/ogg/wav 全支持 + 自动重采样 16k），无需 ffmpeg
 *  - 响应：OpenAI 格式 { text }；模型缺失/未就绪时 503 + 明确中文提示（dsh-voice 会把 body 带回给模型）
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BODY = 26 * 1024 * 1024 // 25MB 音频上限 + multipart 开销

/** 从 content-type 头抠 boundary。 */
export function boundaryOf(contentType = '') {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  return m ? (m[1] ?? m[2]).trim() : undefined
}

/**
 * 极简 multipart 解析（Buffer 二进制安全）。
 * 返回 [{ name, filename, data }]；只保留到调用方用完为止（子数组共享内存视图）。
 */
export function parseMultipart(body, boundary) {
  const parts = []
  const delim = Buffer.from(`--${boundary}`)
  let start = body.indexOf(delim)
  while (start !== -1) {
    const next = body.indexOf(delim, start + delim.length)
    if (next === -1)
      break
    const headStart = start + delim.length + 2 // 跳过 "--boundary\r\n"
    const partBuf = body.subarray(headStart, next - 2) // 去掉结尾 "\r\n"
    const sep = partBuf.indexOf('\r\n\r\n')
    if (sep > 0) {
      const headerText = partBuf.subarray(0, sep).toString('utf8')
      const data = partBuf.subarray(sep + 4)
      const name = /name="([^"]*)"/i.exec(headerText)?.[1] ?? ''
      const filename = /filename="([^"]*)"/i.exec(headerText)?.[1] ?? ''
      parts.push({ name, filename, data })
    }
    start = next
  }
  return parts
}

/** ABI → 随包二进制路径。 */
export function binaryFor(libDir, arch = process.arch) {
  const name = arch === 'arm64' ? 'whisper-cli-arm64' : arch === 'x64' ? 'whisper-cli-x86_64' : undefined
  if (!name)
    return undefined
  const p = join(libDir, 'bin', name)
  return existsSync(p) ? p : undefined
}

/**
 * 起 OpenAI 兼容服务。
 * 返回 { port, close() }。
 */
export function startServer(options) {
  const { port = 8941, whisperBin, modelDir, defaultModel = 'base-q5_1', log = () => {} } = options
  mkdirSync(modelDir, { recursive: true })
  const tmpDir = join(modelDir, 'tmp')
  mkdirSync(tmpDir, { recursive: true })

  const modelPath = name => join(modelDir, `ggml-${name}.bin`)

  /** 跑一次转写：音频 Buffer → 文本。 */
  async function transcribeBuffer(audio, filename = 'audio.wav', { model = defaultModel, language, prompt } = {}) {
    if (!whisperBin)
      throw new Error('whisper.cpp 二进制缺失（本包应含 lib/bin/whisper-cli-<abi>）')
    const modelFile = modelPath(model)
    if (!existsSync(modelFile)) {
      const e = new Error(`本地 ASR 模型未下载：${model}（模型目录 ${modelDir}）。请先调用 voice_local_bootstrap 下载模型。`)
      e.status = 503
      throw e
    }
    const id = randomUUID()
    const tmp = join(tmpDir, `asr-${id}-${(filename || 'audio.wav').replace(/[^\w.-]/g, '_')}`)
    writeFileSync(tmp, audio)
    try {
      const args = ['-m', modelFile, '-f', tmp, '-nt', '-np']
      if (language)
        args.push('-l', language)
      if (prompt)
        args.push('--prompt', prompt)
      const text = await new Promise((resolve, reject) => {
        const child = spawn(whisperBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        let err = ''
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error('whisper 转写超时（10 分钟）'))
        }, 600_000)
        child.stdout.on('data', d => (out += d.toString('utf8')))
        child.stderr.on('data', d => (err += d.toString('utf8')))
        child.on('error', reject)
        child.on('close', (code) => {
          clearTimeout(timer)
          try { unlinkSync(tmp) } catch {}
          if (code === 0) resolve(out)
          else reject(new Error(`whisper 退出码 ${code}：${err.slice(-300) || out.slice(-300)}`))
        })
      })
      // -nt 模式下 stdout 即纯文本（可能带空行）
      return text.replace(/\uFEFF/g, '').trim()
    }
    finally {
      try { unlinkSync(tmp) } catch {}
    }
  }

  const server = http.createServer((req, res) => {
    const finish = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    // 健康检查 / 状态（给工具与探针用）
    if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/v1/status')) {
      return finish(200, { ok: true, models: listModels(modelDir), defaultModel })
    }
    if (req.method !== 'POST' || !/^\/v1\/audio\/transcriptions$/.test(req.url ?? '')) {
      return finish(404, { error: { message: '只支持 POST /v1/audio/transcriptions' } })
    }
    const chunks = []
    let size = 0
    let aborted = false
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        aborted = true
        return finish(413, { error: { message: '音频超过 25MB 上限' } })
      }
      chunks.push(c)
    })
    req.on('end', async () => {
      if (aborted)
        return
      try {
        const boundary = boundaryOf(req.headers['content-type'])
        if (!boundary)
          return finish(400, { error: { message: '缺少 multipart boundary' } })
        const parts = parseMultipart(Buffer.concat(chunks), boundary)
        const filePart = parts.find(p => p.name === 'file') ?? parts.find(p => p.filename)
        if (!filePart || filePart.data.length === 0)
          return finish(400, { error: { message: '缺少 file 字段（音频内容）' } })
        const field = n => parts.find(p => p.name === n)?.data.toString('utf8').trim()
        const text = await transcribeBuffer(filePart.data, filePart.filename || 'audio.wav', {
          model: field('model') || defaultModel,
          language: field('language'),
          prompt: field('prompt'),
        })
        log(`转写完成（${(filePart.data.length / 1024).toFixed(0)}KB）`)
        return finish(200, { text })
      }
      catch (error) {
        const status = error?.status ?? 500
        log(`转写失败：${String(error?.message ?? error).slice(0, 120)}`)
        return finish(status, { error: { message: String(error?.message ?? error) } })
      }
    })
    req.on('error', () => {})
  })

  return new Promise((resolve) => {
    server.on('error', (e) => {
      log(`本地 ASR 服务启动失败：${e.message}`)
      resolve({ port, close: () => {}, failed: true, error: e.message })
    })
    server.listen(port, '127.0.0.1', () => {
      log(`本地 ASR 服务已就绪：http://127.0.0.1:${port}/v1/audio/transcriptions`)
      resolve({ port, close: () => server.close(() => {}), failed: false })
    })
  })
}

/** 列出已下载的模型。 */
export function listModels(modelDir) {
  if (!existsSync(modelDir))
    return []
  const out = []
  try {
    for (const name of readdirSync(modelDir)) {
      if (!/^ggml-.+\.bin$/.test(name))
        continue
      const st = statSync(join(modelDir, name))
      out.push({ name, sizeBytes: st.size, model: name.replace(/^ggml-/, '').replace(/\.bin$/, '') })
    }
  }
  catch {}
  return out
}
