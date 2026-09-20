/**
 * 模型 bootstrap：从 HF（或国内镜像 hf-mirror）下载 whisper.cpp 的 ggml 模型。
 *
 * 断点续传不做（模型几十到一两百 MB，重下成本低）；写 .part 再原子改名，避免半截文件被误用。
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SOURCES = [
  name => `https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`, // 国内镜像优先
  name => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`,
]

/** 支持的模型清单（名字 → 下载体积），供状态展示与参数校验。 */
export const MODELS = {
  'tiny-q5_1': 32_152_673,
  'base-q5_1': 59_707_625,
  'small-q5_1': 190_085_487,
  'base': 147_980_313,
  'small': 465_687_407,
}

/** 是否受支持的名字（允许用户自定义，只要域名能解析 ggml-<名字>.bin 就行）。 */
export function isKnownModel(name) {
  return Boolean(MODELS[name])
}

/**
 * 下载模型。返回 { ok, path, size, source, note }。
 * onProgress(loaded, total, source) 可选。
 */
export function downloadModel(name, modelDir, onProgress) {
  mkdirSync(modelDir, { recursive: true })
  const target = join(modelDir, `ggml-${name}.bin`)
  if (existsSync(target)) {
    return { ok: true, path: target, size: statSync(target).size, source: 'cached', note: '模型已存在，无需下载' }
  }
  const errors = []
  return new Promise((resolve) => {
    const attempt = async (index) => {
      if (index >= SOURCES.length) {
        resolve({ ok: false, path: target, note: `全部下载源失败：${errors.join('；')}` })
        return
      }
      const url = SOURCES[index](name)
      const source = index === 0 ? 'hf-mirror' : 'huggingface'
      const part = `${target}.part`
      try {
        const res = await fetch(url, { redirect: 'follow' })
        if (!res.ok || !res.body)
          throw new Error(`HTTP ${res.status}`)
        const total = Number(res.headers.get('content-length') ?? 0)
        const out = createWriteStream(`${part}.tmp`)
        let loaded = 0
        const reader = res.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done)
            break
          out.write(value)
          loaded += value.length
          onProgress?.(loaded, total || 0, source)
        }
        out.end()
        await new Promise((r) => {
          out.on('close', r)
          out.on('error', r)
        })
        if (loaded < 1_000_000)
          throw new Error(`下载体积异常（${loaded} 字节），疑似错误页`)
        renameSync(part, target)
        resolve({ ok: true, path: target, size: statSync(target).size, source, note: `下载完成（${(loaded / 1048576).toFixed(1)}MB，源 ${source}）` })
      }
      catch (error) {
        errors.push(`${source}: ${String(error instanceof Error ? error.message : error)}`)
        if (existsSync(part)) {
          try { renameSync(part, `${part}.broken`) } catch {}
        }
        attempt(index + 1)
      }
    }
    attempt(0)
  })
}
