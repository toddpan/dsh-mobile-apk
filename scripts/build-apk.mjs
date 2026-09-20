// build-apk.mjs — 跨平台 APK 编排（复用已平台化的 gate 脚本；Windows 走 WSL、Linux 原生）
//
// 对应本地 scripts/build-apk-013.ps1（PowerShell + wsl，仅 Windows）。本脚本是「可移植版」：
// 在云端的 GHA ubuntu（原生 Linux）跑，也可在本地 Windows 跑（gate 脚本自带平台感知）。
// 共享的 gate/注入脚本（inject-snapshot.py / check-third-party.mjs / check-snapshot-secrets.mjs /
// elf-check.mjs / check-patch-mounts.mjs / patch-marketplace.mjs / patch-undo-mobile.mjs）均为跨平台。
//
// 用法：node scripts/build-apk.mjs --abi arm64|x86_64 [--suffix "-v3"] [--snapshot <snap.tar.xz>] [--skip-inject]
// 依赖：node、python 在 PATH；dsh-mobile-apk/ 子仓库在 ROOT；vendor/{dsh-undo-savepoint,dshmarketplace-plugin} 在场。
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, existsSync, rmSync, copyFileSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
// apk 仓库目录：默认 ROOT/dsh-mobile-apk（本仓库布局）；云端 workflow 宿主若=apk 仓库（GITHUB_WORKSPACE），
// 用 DSH_APK_DIR 覆盖（此时 ROOT 指向作为依赖签出的协调库子目录）。
const apkDir = process.env.DSH_APK_DIR || join(ROOT, 'dsh-mobile-apk')
const OUT = join(ROOT, 'out', 'v0.13.0')
const SUFFIX_DEFAULT = '-ci'
const VER = '0.13.0'

// ---- 参数解析 ----
const args = process.argv.slice(2)
function opt(name, def) {
  const i = args.indexOf('--' + name)
  return i >= 0 ? (args[i + 1] ?? def) : def
}
const ABI = opt('abi', 'arm64')
// python 可执行名自适应：macOS/Linux 通常只有 python3（Windows 一般是 python）
const PY = existsSync('/usr/bin/python') ? 'python'
  : ['python3', 'python'].find(c => spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0) ?? 'python3'
const SUFFIX = opt('suffix', SUFFIX_DEFAULT)
const SKIP_INJECT = args.includes('--skip-inject')
// 逃生口（2026-09-20）：check-third-party 对快照源 usr/share/LICENSES 悬空符号链接的既有缺口
// （见 docs/AGENTS/VOICE-PLUGINS.md §8.1——未注入的原始快照同样报错，与本批改动无关）。
// 默认仍跑门禁；本地迭代可 --skip-third-party 跳过，发版前须另行补快照源的 LICENSES 装配。
const SKIP_THIRD_PARTY = args.includes('--skip-third-party')
const SNAP = opt('snapshot', '')

if (!['arm64', 'x86_64'].includes(ABI)) { console.error(`未知 ABI: ${ABI}`); process.exit(2) }

// 语音本地 ASR：把 vendor/dsh-local-asr 裁剪出「只带当前 ABI 二进制」的临时副本再注入。
function stageLocalAsr(root, workDir, abi) {
  const src = join(root, 'vendor', 'dsh-local-asr')
  const dst = join(workDir, 'dsh-local-asr')
  const libSrc = join(src, 'lib')
  const binName = abi === 'x86_64' ? 'whisper-cli-x86_64' : 'whisper-cli-arm64'
  mkdirSync(join(dst, 'lib', 'bin'), { recursive: true })
  for (const f of ['package.json', 'cordis.patch.yml'])
    copyFileSync(join(src, f), join(dst, f))
  for (const f of readdirSync(libSrc)) {
    if (f.endsWith('.js'))
      copyFileSync(join(libSrc, f), join(dst, 'lib', f))
  }
  copyFileSync(join(libSrc, 'bin', binName), join(dst, 'lib', 'bin', binName))
  return dst
}

// 提示词增强本地 ASR 运行时（2026-09-20）：shim worker + sherpa-onnx Termux CLI（按 ABI 裁剪）
// + SenseVoice 模型 + 插件默认配置（引擎=本地）。overlay 布局 = home/**，经 inject-all --extra 注入。
function stagePeAsr(root, workDir, abi) {
  const src = join(root, 'vendor', 'dsh-prompt-enhancer-asr-runtime')
  const dst = join(workDir, 'pe-asr-runtime')
  const asrSrc = join(src, 'home', '.dsh', 'dsh-prompt-enhancer-asr')
  const asrDst = join(dst, 'home', '.dsh', 'dsh-prompt-enhancer-asr')
  mkdirSync(join(asrDst, 'bin'), { recursive: true })
  mkdirSync(join(asrDst, 'lib'), { recursive: true })
  mkdirSync(join(asrDst, 'models', 'sense-voice'), { recursive: true })
  copyFileSync(join(src, 'home', '.dsh', 'dsh-prompt-enhancer.config.json'), join(dst, 'home', '.dsh', 'dsh-prompt-enhancer.config.json'))
  copyFileSync(join(asrSrc, 'asr-worker.cjs'), join(asrDst, 'asr-worker.cjs'))
  copyFileSync(join(asrSrc, 'bin', `sherpa-onnx-offline-${abi}`), join(asrDst, 'bin', 'sherpa-onnx-offline'))
  for (const f of readdirSync(join(asrSrc, `lib-${abi}`)))
    copyFileSync(join(asrSrc, `lib-${abi}`, f), join(asrDst, 'lib', f))
  for (const f of readdirSync(join(asrSrc, 'models', 'sense-voice')))
    copyFileSync(join(asrSrc, 'models', 'sense-voice', f), join(asrDst, 'models', 'sense-voice', f))
  return dst
}

const pluginDirs = [
  join(ROOT, 'dsh-shell-termux'),
  join(ROOT, 'dsh-client-ui-responsive'),
  join(ROOT, 'dsh-host-web-compat'),
  join(ROOT, 'plugins', 'dsh-android-bridge'),
  join(ROOT, 'plugins', 'dsh-android-manage'),
  join(ROOT, 'plugins', 'dsh-android-linux-env'),
  join(ROOT, 'plugins', 'dsh-android-file-open'),
]
const undo = join(ROOT, 'vendor', 'dsh-undo-savepoint')
const market = join(ROOT, 'vendor', 'dshmarketplace-plugin')
const modelSync = join(ROOT, 'vendor', 'dsh-model-sync') // 0.13.3 W7：@aiwayds/dsh-model-sync 0.3.1 固化副本
// 语音双件套（移动端只用网络通道）：dsh-voice=edge-tts/ASR（纯 JS），dsh-gsv-tts=TTS 面板+Edge 云端模式
// （**锁 edge provider**——本地 GSV 引擎要 Python+模型，Termux 上不可行，见 docs/AGENTS/VOICE-PLUGINS.md）
const voice = join(ROOT, 'vendor', 'dsh-voice')
const gsvTts = join(ROOT, 'vendor', 'dsh-gsv-tts')
// 提示词增强（2026-09-20）：composer ✨/🎤 双面插件 + 本地 SenseVoice ASR 运行时（--extra overlay 注入）
const peEnh = join(ROOT, 'vendor', 'dsh-prompt-enhancer')
const work = join(ROOT, '.deploy-tmp', `build-${ABI}`)
const snapSrc = SNAP || join(ROOT, '.deploy-tmp', 'snapshot-013', ABI, 'snapshot.tar.xz')

function log(m) { console.log(`[build-apk/${ABI}] ${m}`) }
function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', ...opts })
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} 失败 (${r.status})`)
  return r
}
function requires(name, p) { if (!existsSync(p)) { console.error(`缺 ${name}: ${p}`); process.exit(2) } }

try {
  mkdirSync(OUT, { recursive: true })
  mkdirSync(work, { recursive: true })

  // ---- 0. 前置：基座/插件/vendor 在场 ----
  requires('snapshot 源', snapSrc)
  pluginDirs.forEach((p) => requires('插件', p))
  requires('vendor undo', join(undo, 'package.json'))
  requires('vendor market', join(market, 'package.json'))
  requires('vendor model-sync', join(modelSync, 'lib', 'index.js'))
  requires('vendor voice', join(voice, 'lib', 'index.js'))
  requires('vendor gsv-tts', join(gsvTts, 'lib', 'index.js'))
  requires('vendor local-asr', join(ROOT, 'vendor', 'dsh-local-asr', 'lib', 'index.js'))
  requires('vendor prompt-enhancer', join(peEnh, 'lib', 'index.cjs'))
  requires('vendor pe-asr runtime', join(ROOT, 'vendor', 'dsh-prompt-enhancer-asr-runtime', 'home', '.dsh', 'dsh-prompt-enhancer-asr', 'bin', `sherpa-onnx-offline-${ABI}`))
  requires('vendor pe-asr model', join(ROOT, 'vendor', 'dsh-prompt-enhancer-asr-runtime', 'home', '.dsh', 'dsh-prompt-enhancer-asr', 'models', 'sense-voice', 'model.int8.onnx'))

  let snapIn
  /** 语音本地 ASR 的裁剪副本（按 ABI 只带一个 whisper 二进制）；无注入时为空，门禁跳过该项。 */
  let localAsrDir
  /** 提示词增强本地 ASR 运行时 overlay（shim worker + CLI + 模型 + 默认配置）；--extra 注入。 */
  let peAsrDir
  if (!SKIP_INJECT) {
    // ---- 1. 插件注入链（python，跨平台）----
    // 统一补丁门禁（Phase 2a）：undo E1-E7 + marketplace A-D 幂等施加与校验（registry.json）
    run('node', [join(ROOT, 'scripts', 'patches', 'apply-patches.mjs'), join(ROOT, 'vendor')])
    log('单 pass 注入（@dsh-android + undo/market + 权威 patch）…')
    // 语音本地 ASR：按 ABI 裁剪 whisper 二进制——快照按 ABI 分包，一份只带对应架构（省 ~23MB）
    localAsrDir = stageLocalAsr(ROOT, work, ABI)
    peAsrDir = stagePeAsr(ROOT, work, ABI)
    run(PY, [join(ROOT, 'scripts', 'inject-all.py'), snapSrc, join(work, 'snap-final2.tar.xz'), join(ROOT, 'scripts', 'profile-web.cordis.patch.yml'), '--dsh-android', ...pluginDirs, '--external', undo, market, modelSync, voice, gsvTts, localAsrDir, peEnh, '--extra', peAsrDir])
    snapIn = join(work, 'snap-final2.tar.xz')
  } else {
    snapIn = snapSrc
  }

  // ---- 2. 门禁（全部跨平台脚本）----
  log('门禁：patch 挂载集校验…')
  run('node', [join(ROOT, 'scripts', 'check-patch-mounts.mjs'), join(ROOT, 'scripts', 'profile-web.cordis.patch.yml'), ...pluginDirs, undo, market, modelSync, voice, gsvTts, peEnh, ...(localAsrDir ? [localAsrDir] : [])])
  if (!SKIP_THIRD_PARTY) {
    log('门禁：第三方许可…')
    run('node', [join(ROOT, 'scripts', 'check-third-party.mjs'), 'x', '--tar', snapIn])
  } else {
    log('门禁：第三方许可…跳过（--skip-third-party，既有缺口见 docs/AGENTS/VOICE-PLUGINS.md §8.1）')
  }
  log('门禁：机密…')
  run('node', [join(ROOT, 'scripts', 'check-snapshot-secrets.mjs'), snapIn])
  log('门禁：ELF 架构…')
  run('node', [join(ROOT, 'scripts', 'elf-check.mjs'), snapIn, ABI])

  // ---- 3. 许可资产（LICENSES + notices -> APK assets/licenses）----
  const licAssets = join(apkDir, 'app', 'src', 'main', 'assets', 'licenses')
  mkdirSync(licAssets, { recursive: true })
  for (const f of readdirSync(join(ROOT, 'LICENSES'))) if (f.endsWith('.txt')) copyFileSync(join(ROOT, 'LICENSES', f), join(licAssets, f))
  copyFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), join(licAssets, 'THIRD_PARTY_NOTICES.md'))
  log('许可资产就位')

  // ---- 4. 快照 + 指纹写入 assets（防增量叠加缓存：先清 intermediates/输出）----
  rmSync(join(apkDir, 'app', 'build', 'intermediates', 'assets'), { recursive: true, force: true })
  rmSync(join(apkDir, 'app', 'build', 'outputs', 'apk', 'debug'), { recursive: true, force: true })
  copyFileSync(snapIn, join(apkDir, 'app', 'src', 'main', 'assets', 'snapshot.tar.xz'))
  const sha = createHash('sha256').update(readFileSync(snapIn)).digest('hex')
  writeFileSync(join(apkDir, 'app', 'src', 'main', 'assets', 'snapshot.sha256'), sha, 'ascii')
  log(`snapshot.sha256 = ${sha}`)

  // ---- 5. gradle assembleDebug（跨平台 gradlew）----
  log('构建 APK…')
  const gradleCmd = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
  const gr = spawnSync(gradleCmd, [':app:assembleDebug', '--no-daemon', `-PversionNameSuffix=${SUFFIX}`], { cwd: apkDir, stdio: 'inherit', shell: process.platform === 'win32' })
  if (gr.status !== 0) { console.error(`gradle 失败 (${gr.status})`); process.exit(1) }

  // ---- 6. 产物拷贝 ----
  const name = `dsh-mobile-apk-v${VER}${SUFFIX}-${ABI}.apk`
  copyFileSync(join(apkDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'), join(OUT, name))
  log(`产物: ${join(OUT, name)}`)
  console.log(`=== 完成（${ABI} ${SUFFIX}）===\nAPK=${join(OUT, name)}`)
} catch (e) {
  console.error(`[build-apk/${ABI}] ${e.message}`)
  process.exit(1)
}
