/**
 * dsh-local-asr — 本地 ASR（whisper.cpp + OpenAI 兼容服务）。
 *
 * 做三件事：
 *  1. 引擎激活时起本地服务 127.0.0.1:8941（OpenAI 兼容 /v1/audio/transcriptions，multipart）
 *  2. 把 dsh-voice 的 ASR 指到本地（patch 里 asrEngine=custom + asrBaseUrl 已配好）
 *  3. 给模型/服务三个工具：voice_local_status / voice_local_bootstrap / voice_local_transcribe
 *
 * 首次使用：跑 voice_local_bootstrap 下载模型（默认 base-q5_1 ≈ 60MB，中文建议 small-q5_1 ≈ 190MB）。
 */
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadModel, isKnownModel, MODELS } from './bootstrap.js'
import { binaryFor, listModels, startServer } from './server.js'

const LIB_DIR = join(dirname(fileURLToPath(import.meta.url)))
const PORT = 8941
const DEFAULT_MODEL = 'base-q5_1'
/** 模型目录：Termux 上 HOME = files/home，随应用数据持久化。 */
const MODEL_DIR = join(process.env.HOME ?? join(LIB_DIR, '..', '..', '..', '..', '..'), '.dsh', 'local-asr', 'models')

export const inject = ['tools']

export function apply(ctx, config) {
  const cfg = { port: PORT, autoStart: true, ...(config ?? {}) }
  const whisperBin = binaryFor(LIB_DIR, process.arch)
  let server
  const log = (message) => {
    console.log(`[dsh-local-asr] ${message}`)
  }

  const modelReady = () => existsSync(join(MODEL_DIR, `ggml-${cfg.model ?? DEFAULT_MODEL}.bin`))

  const ensureServer = async () => {
    if (server)
      return server
    if (!whisperBin) {
      server = { failed: true, error: `本机架构 ${process.arch} 没有对应的 whisper 二进制` }
      return server
    }
    server = await startServer({
      port: cfg.port,
      whisperBin,
      modelDir: MODEL_DIR,
      defaultModel: cfg.model ?? DEFAULT_MODEL,
      log,
    })
    return server
  }

  if (cfg.autoStart) {
    // 备场即起服务：起不来不影响引擎（失败安全），工具里能看到原因
    void ensureServer()
  }

  const statusPayload = () => {
    const bin = Boolean(whisperBin)
    const models = listModels(MODEL_DIR)
    const ready = bin && models.some(m => m.model === (cfg.model ?? DEFAULT_MODEL))
    return {
      arch: process.arch,
      binary: bin ? whisperBin : null,
      binaryReady: bin,
      modelDir: MODEL_DIR,
      defaultModel: cfg.model ?? DEFAULT_MODEL,
      models,
      modelReady,
      serverRunning: Boolean(server && !server.failed),
      serverError: server?.failed ? server.error : undefined,
      endpoint: `http://127.0.0.1:${cfg.port}/v1/audio/transcriptions`,
      ready: ready && Boolean(server && !server.failed),
      supportedModels: Object.keys(MODELS),
    }
  }

  const disposers = []

  disposers.push(ctx.tools.register({
    name: 'voice_local_status',
    description: '本地 ASR（whisper.cpp）状态：二进制/模型/服务三件事各自是否就绪，缺什么、怎么补。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => {
        const lines = [
          `二进制：${v.binaryReady ? '就绪' : '缺失'}（${v.arch}）`,
          `模型目录：${v.modelDir}`,
          `模型：${v.models.length === 0 ? '未下载' : v.models.map(m => `${m.model}(${(m.sizeBytes / 1048576).toFixed(0)}MB)`).join('、')}`,
          `默认模型 ${v.defaultModel}：${v.modelReady ? '已下载' : '未下载 —— 跑 voice_local_bootstrap 下载'}`,
          `服务：${v.serverRunning ? `运行中（${v.endpoint}）` : `未运行${v.serverError ? `（${v.serverError}）` : ''}`}`,
          `整体：${v.ready ? '✅ 本地 ASR 可用' : '❌ 尚未就绪'}`,
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      return statusPayload()
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'voice_local_bootstrap',
    description: `下载本地 ASR 模型（whisper.cpp ggml 格式）。可选 ${Object.keys(MODELS).join(' / ')}；默认 ${DEFAULT_MODEL}（≈60MB，中英可用）；中文要求高选 small-q5_1（≈190MB）。自动尝试 hf-mirror 镜像再回退 huggingface。`,
    parameters: {
      type: 'object',
      properties: {
        model: { type: 'string', description: `模型名（可选，默认 ${DEFAULT_MODEL}）。可选：${Object.keys(MODELS).join(' / ')}` },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{
        type: 'text',
        text: v.ok ? `模型 ${v.model} 就绪（${(v.sizeBytes / 1048576).toFixed(1)}MB，源 ${v.source}），本地 ASR 已可用。` : `下载失败：${v.note}`,
      }],
    },
    async execute(args) {
      const model = typeof args?.model === 'string' && args.model.trim() !== '' ? args.model.trim() : (cfg.model ?? DEFAULT_MODEL)
      if (!isKnownModel(model) && !/^[\w.-]+$/.test(model))
        throw new Error(`模型名不合法：${model}（可选：${Object.keys(MODELS).join(' / ')}）`)
      const res = await downloadModel(model, MODEL_DIR)
      return { ok: res.ok, model, sizeBytes: res.size ?? 0, source: res.source ?? '-', note: res.note, ...statusPayload() }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'voice_local_transcribe',
    description: '本地转写：直接调 whisper.cpp（不走 HTTP，不受服务状态影响）。audio 为音频路径（mp3/flac/ogg/wav，自动重采样 16k）。离线可用。',
    parameters: {
      type: 'object',
      properties: {
        audio: { type: 'string', required: true, description: '音频文件路径（必填）。' },
        model: { type: 'string', description: `模型名（可选，默认 ${DEFAULT_MODEL}）。` },
        language: { type: 'string', description: '语言提示，如 zh / en（可选，默认自动检测）。' },
        prompt: { type: 'string', description: '提示词（专有名词/术语纠偏，可选）。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, model: { type: 'string' }, audio: { type: 'string' } }, additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: `本地转写完成（模型 ${v.model}）：${v.text}` }],
    },
    async execute(args) {
      const audio = typeof args?.audio === 'string' ? args.audio : ''
      if (audio === '' || !existsSync(audio))
        throw new Error(`音频文件不存在：${audio}`)
      if (!whisperBin)
        throw new Error(`本机架构 ${process.arch} 没有对应的 whisper 二进制（本包 lib/bin/ 应含 whisper-cli-arm64 / whisper-cli-x86_64）`)
      const model = typeof args?.model === 'string' && args.model.trim() !== '' ? args.model.trim() : (cfg.model ?? DEFAULT_MODEL)
      const modelFile = join(MODEL_DIR, `ggml-${model}.bin`)
      if (!existsSync(modelFile))
        throw new Error(`模型未下载：${model}（${modelFile}）。先跑 voice_local_bootstrap。`)
      // 复用 server.js 的转写逻辑（不启 HTTP）：直接拼 whisper-cli 调用
      const { spawn } = await import('node:child_process')
      const tmp = join(MODEL_DIR, `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
      try {
        copyFile(audio, tmp)
      }
      catch (error) {
        throw new Error(`无法读取音频文件：${String(error)}`)
      }
      try {
        const text = await new Promise((resolve, reject) => {
          const a = [ '-m', modelFile, '-f', tmp, '-nt', '-np' ]
          if (typeof args?.language === 'string' && args.language.trim() !== '')
            a.push('-l', args.language.trim())
          if (typeof args?.prompt === 'string' && args.prompt.trim() !== '')
            a.push('--prompt', args.prompt)
          const child = spawn(whisperBin, a, { stdio: ['ignore', 'pipe', 'pipe'] })
          let out = ''
          let err = ''
          const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('whisper 转写超时（10 分钟）')) }, 600_000)
          child.stdout.on('data', d => (out += d.toString('utf8')))
          child.stderr.on('data', d => (err += d.toString('utf8')))
          child.on('error', reject)
          child.on('close', (code) => {
            clearTimeout(timer)
            if (code === 0) resolve(out.replace(/\uFEFF/g, '').trim())
            else reject(new Error(`whisper 退出码 ${code}：${err.slice(-300) || out.slice(-300)}`))
          })
        })
        return { text, model, audio }
      }
      finally {
        cleanTempFiles(MODEL_DIR)
      }
    },
  }))

  ctx.on('dispose', () => {
    for (const dispose of disposers) {
      try { dispose() } catch {}
    }
    try { server?.close?.() } catch {}
  })
}

/** 把源音频复制到模型目录下的临时文件（whisper 对中文/空格路径更稳）。 */
function copyFile(src, dst) {
  writeFileSync(dst, readFileSync(src))
}

/** 清掉模型目录里的临时音频（只动本插件创建的 tmp-* 文件）。 */
function cleanTempFiles(dir) {
  try {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith('tmp-'))
        continue
      try { unlinkSync(join(dir, f)) } catch {}
    }
  }
  catch {}
}
