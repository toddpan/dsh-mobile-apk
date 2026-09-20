# PROMPT-ENHANCER-ASR.md — dsh-prompt-enhancer 预装 + 本地 SenseVoice ASR（Termux）

> 2026-09-20 集成（未发版）。把桌面插件 dsh-prompt-enhancer（✨ 提示词增强 + 🎤 语音识别）
> 随 APK 快照预装，并让 🎤 的**本地引擎**（SenseVoice，sherpa-onnx）在 Termux 里真实可用。
> 上游：https://github.com/Fishsb/dsh-prompt-enhancer（本批基于 v3.4.0 / 8026fdf）。

## 1. 结论一句话

**本地 ASR 全链路已在 arm64 模拟器实测打通**：引擎启动 → 插件 host 挂载 → ensureWorker
自动拉起 Termux shim worker（:3082）→ spawn 官方 sherpa-onnx Termux 构建
`bin/sherpa-onnx-offline` → 随包 SenseVoice int8 模型识别 → 文本回填插件 /rpc 契约。
实测 3.4s 中文语音识别完全正确（首跑 11.8s，热缓存 1.0s）。
✨/🎤 客户端按钮（client face）未渲染——见 §6 已知缺口。

## 2. 组成（本批新增/改动）

| 位置 | 内容 |
|---|---|
| `vendor/dsh-prompt-enhancer/` | 插件 v3.4.0 固化副本（package.json + cordis.patch.yml + lib/ + skills/ + **plugin-host.js** + **node_modules/undici**）。lib 两处 Termux 适配补丁见 §3 |
| `vendor/dsh-prompt-enhancer-asr-runtime/` | ASR 运行时 overlay（`home/.dsh/...` 布局）：shim worker、双 ABI 的 `sherpa-onnx-offline` + `lib/*.so`（含 `libc++_shared.so`）、SenseVoice 模型（model.int8.onnx 228MB + tokens.txt）、默认配置 `home/.dsh/dsh-prompt-enhancer.config.json`（engine=local + sense-voice）。**模型不入库**（239MB 超 GitHub 单文件上限，gitignore + `scripts/fetch-pe-asr-model.sh` 拉取，hf-mirror 优先） |
| `scripts/inject-all.py` | ① `--extra <overlay-dir>` 通道（任意路径 overlay：命中即替换、否则追加、父目录补齐、权限按内容归一化）；② EXT_INCLUDE_FILES += `plugin-host.js`/`plugin-client.js`（包根双面 bundle）；③ os.walk 读文件 OSError 跳过（悬空符号链接不致命） |
| `scripts/inject-external-plugins.py` | INCLUDE_FILES 同步 += 两个 bundle 文件（与 inject-all 语义一致） |
| `scripts/build-apk.mjs` | ① external 追加 `vendor/dsh-prompt-enhancer` + 在场校验；② `stagePeAsr()` 按 ABI 裁剪运行时 overlay → `--extra` 注入；③ `--skip-third-party` 逃生口（既有缺口见下） |
| `THIRD_PARTY_NOTICES.md` | 登记 dsh-prompt-enhancer（**上游无 LICENSE 文件，发版前须与上游确认**）、undici 7.29.1 MIT、sherpa-onnx 1.13.8 Apache-2.0、SenseVoice 模型 Apache-2.0 |

构建链：`bash scripts/fetch-pe-asr-model.sh && node scripts/build-apk.mjs --abi arm64 --suffix "-pe-asr2" --snapshot <基座> --skip-third-party`
（基座 = preinstall 批的快照；本批注入会把 voice 批插件补齐回快照——inject-all 对缺失包是追加语义）。

## 3. 插件 host 侧 Termux 适配补丁（vendor 副本，带 `[移动端适配 Termux 2026-09-20]` 注释）

| 文件 | 补丁 |
|---|---|
| `lib/asr-models.cjs` | `workerListenerPids()`：netstat -ano/LISTENING 是 Windows 专用（Termux 无此语义），非 win32 改读 **worker.pid 自报文件**（shim 启动时写 `{pid,port}`）+ `/proc/<pid>/cmdline` 核验（防 pid 复用误杀）。探活/杀旧进程/幂等全部靠它 |
| `lib/asr-deploy.cjs` | `checkRuntime().sherpaPkg` 同时接受 `bin/sherpa-onnx-offline`（CLI 运行时形态）；`startDeploy()` 在 android/预装形态下**不复制上游 worker、不跑 npm install**（会覆盖 shim / 必然失败），运行时缺失如实报错 |

## 4. shim worker（`asr-worker.cjs`，Termux 版）

与上游 lib/asr-worker.cjs 的 HTTP 契约完全一致（`GET /health`、`POST /rpc` 的
status/transcribe、固定口 3082 + EADDRINUSE 动态口 fallback + worker.port 文件），
仅推理实现不同：不走 node 版 sherpa-onnx NAPI（glibc 预编译，Android bionic 不可用），
改 spawn `bin/sherpa-onnx-offline`：

- 旗标：`--tokens= --sense-voice-model= --sense-voice-language= --sense-voice-use-itn=1 <wav>`
  （macOS 同版本 CLI 实测旗标与输出格式一致；stdout 为单行 JSON `{"text": ...}`，shim 按此解析）
- `LD_LIBRARY_PATH` **只含运行时 lib/**（libc++_shared.so 已随包放进去）。
  **不能**把 Termux usr/lib 或继承的引擎 LD_LIBRARY_PATH 加进来——系统库解析被劫持，
  API 35 上实测 `/system/lib64/libunwindstack.so` 报 `Xzs_Construct` 找不到，CLI 直接起不来
- 音频中转文件放运行时自带 `tmp/`，**不用 os.tmpdir()**（Termux node 把 tmpdir 烧死在
  com.termux 前缀，app 域 ENOENT）
- 额外写 `worker.pid`（host 补丁消费，见 §3）
- paraformer 类型模型走 `--paraformer=`（清单内另一模型）；whisper 类型未支持

## 5. 模拟器实测记录（moss_tts_test，arm64 API 35，adb 走 5038）

- 快照事务刷新：新快照 sha 1629f4a1（pe-asr2）；首装/升级刷新全程 ~12 分钟，
  完成标志 = `.snapshot-fingerprint` 翻转 + `.snapshot-transaction` 消失（坑 37 口径）
- 文件面：`files/home/.dsh/dsh-prompt-enhancer-asr/{asr-worker.cjs,bin,lib,models/sense-voice}`、
  `files/home/.dsh/dsh-prompt-enhancer.config.json`、插件包（含 plugin-host.js/undici）全部落位
- worker 全链：`/health` `{"ok":true,"modelReady":true}`；`/rpc status` modelReady=true；
  `/rpc transcribe`（3.4s 16k 中文 wav）→ `{"ok":true,"text":"今天天气怎么样？适合出门跑步吗？"}`
- 引擎自启：引擎 boot +5s 的 ensureWorker 在真实路径下拉起 shim（worker.pid=引擎代 spawn 的 pid）
- 引擎启动崩溃两根因见 §7（修复后冷启动 ~30s 即 3080 响应）

## 6. 已知缺口（如实记录）

1. **✨/🎤 composer 按钮未渲染（client face 未被引擎 serve）**：引擎 client-modules 扫描
   （`__DSH_BOOT__.entries` 57 项 + startup combo）不含 dsh-prompt-enhancer，而同通道的
   dsh-gsv-tts/dsh-undo-savepoint 都在。已排除：lib/client.js 命名（补了同名文件）、
   exports["./client"] 指向（改指 client.js 亦然）、inject 内容（undo 只 inject
   slots/locale 也在）。combo rev 跨重启不变。**主嫌疑**：插件 v3.4.0 的 main 是
   `lib/index.cjs`，快照引擎 0.1.5-rc.1 的 client 扫描走 loader internal（ESM）resolveSync，
   CJS 主入口包解析失败被静默吞掉（gsv/undo 主入口都是 .js）。下一步：桌面同版本引擎
   复测 v3.4.0 客户端装载；或给引擎 overlay 加 client 解析的 CJS 兜底。
   host 面（含语音识别全部 RPC）不受影响——voice/transcribe 引擎=local 已实测可用。
2. **check-third-party 既有缺口仍在**：快照源 `usr/share/LICENSES` 悬空符号链接（前批记录），
   构建需 `--skip-third-party`；发版前须补快照源 LICENSES 装配。
3. **上游无 LICENSE 文件**（package.json 未声明 license）：合规待与上游确认。
4. **模型 228MB 随包**：APK ~334MB、首启刷新变长（~12 分钟）。若要瘦身可改回
   「首用下载」（上游 voice/modelDownload 自带 hf-mirror 断点续传）。
5. **麦克风端到端（WebView getUserMedia → 🎤）未测**（依赖 §6.1 的按钮渲染）。
   壳侧权限链路已就绪（RECORD_AUDIO + onPermissionRequest 放行，工作区未提交改动）。
6. 引擎 boot 时 `dsh-local-asr`（whisper 服务 :8941）与 ASR worker（:3082）互不相干，
   前者来自语音双件套批次，别混淆。

## 7. 本批踩掉的引擎启动崩溃（历史包遗留，修复于本批 vendor）

1. **voice/gsv-tts vendor 依赖树不完整**（前批 2026-09-17 固化副本缺传递依赖：
   dsh-voice 缺 proxy-agent-negotiate 等、dsh-gsv-tts 缺 xml-escape 等共 60+ 文件）——
   cordis loader 把 `Cannot find package` 视为**致命**：`plugin tree failed to load`
   → 引擎启动即死（表现为启动超时重试、进程 CPU 空转、3080 半开不响应）。
   修复：两个 vendor 目录 `npm install --omit=dev` 补全 + 全量闭包校验脚本核对。
2. **`.dsh/.credentials.yaml.lock` 0 字节陈旧锁**：崩溃循环期间的遗留点文件，
   dsh-atomic-write 等锁超时 → boot 抛错。`*.lock` 通配**不匹配点文件**，要删
   `.*.lock`。这是升级安装的一次性清理（修复依赖树后不再产生）。

> 调试手段备忘：绕过 app 手动起引擎（复刻 EngineManager.shellEnv 的
> HOME/DSH_HOME/TMPDIR/LD_LIBRARY_PATH/LD_PRELOAD/TERMUX_EXEC__* 全套 env，
> `node --expose-internals usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web
> --port 3080 --no-open`）能把「壳 spawn 问题」与「快照/插件问题」一刀切开。
