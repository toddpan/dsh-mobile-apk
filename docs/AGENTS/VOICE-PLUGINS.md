# VOICE-PLUGINS.md — 语音双件套（dsh-voice / dsh-gsv-tts）移动端适配

> 2026-09-17 集成。把桌面 DSH 上已装的 ASR/TTS 插件随 APK 快照预装。
> **一句话结论：移动端只用"网络通道"（Edge 云端 TTS / 云端 ASR），本地 GSV 引擎在 Termux 上不可行、已锁死。**

---

## 1. 装了什么

| 插件 | 版本 | 能力 | 移动端可用性 |
|---|---|---|---|
| **dsh-voice** | 0.3.3 | `voice_tts`（edge-tts 协议，微软神经语音，零配置）/ `voice_stt`（OpenAI 兼容 ASR）/ `voice_list` | ✅ 纯 JS + 纯网络（ws/undici/https-proxy-agent 随包自带） |
| **dsh-gsv-tts** | 4.1.0 | TTS 设置面板、朗读按钮（🔊）、`tts_speak` 等工具、音色市场 | ✅ **仅 Edge 云端模式**（见 §2） |

注入位置：`home/.dsh/profiles/web/node_modules/{dsh-voice,dsh-gsv-tts}/`（与 undo/market/model-sync 同一 external 通道）。

---

## 2. 为什么锁 Edge 云端模式（关键设计决策）

dsh-gsv-tts 是**双 provider** 架构（`provider: 'edge' | 'gsv'`）：

| 模式 | 依赖 | 移动端 |
|---|---|---|
| 🌐 `edge` 云端快速 | 纯网络（`edge-tts-universal`，微软精选音色，MP3 流由 WebView 解码播放） | ✅ **可用** |
| 🖥️ `gsv` 本地专业 | Python + GSV-TTS-Lite 引擎 + GB 级模型 + torch | ❌ **不可行**（Termux 无 torch/GPU；模型体积远超快照预算） |

**锁定的两个理由**：

1. 本地模式需要 `tts_setup_engine` 去装 Python 引擎——Android 上必失败；
2. `migration.resolveProvider()` 的历史包袱：**"配置段存在但无 provider 字段"的旧用户默认落 `gsv`**。
   如果不显式写，一旦设备上出现过旧配置段，插件就会去拉起一个不存在的本地引擎。

→ 权威 patch `scripts/profile-web.cordis.patch.yml` 显式写 `provider: edge` 钉死：

```yaml
- insert:
    - id: dsh-gsv-tts
      name: dsh-gsv-tts
      config:
        provider: edge          # ← 钉死云端模式，永不尝试本地引擎
        autoPlay: false         # WebView 自动播放会被拦，保持用户点 🔊
        defaultVoice: zh-CN-XiaoxiaoNeural
```

**已知缺口（未做，如实记录）**：设置面板里用户仍可手动切到 GSV 本地模式（patch 只定初始值）。
切过去之后 `tts_speak` 会失败并提示引擎未安装——**失败安全**（不会卡死、不会误触发安装流程），
但 UI 不阻止切换。若要彻底隐藏，需要在插件侧加"移动端形态"开关（上游插件改动，超出本仓边界）。

---

## 3. 音频播放链路（为什么 WebView 里能响）

```
用户点 🔊 → DSH Web 客户端 → 插件 webServer 的 /speak 路由
  → TTSService（provider=edge）→ edge-tts-universal 返回 MP3 流
  → AudioStore 落盘 → 同源短链接回传 → WebView <audio> 播放
```

音频是**同源 URL 交给浏览器解码**，不走原生播放器、不需要安卓音频桥。
`autoPlay=false` 是刻意的：WebView 的自动播放策略会拦无手势播放。

---

## 4. ASR（voice_stt）需要什么

| 项 | 说明 |
|---|---|
| 接口 | OpenAI 兼容（默认 Groq，`whisper-large-v3-turbo`） |
| 密钥 | `DSH_VOICE_ASR_KEY` 环境变量，或设置页填 `asrApiKey` |
| 没配 key | `voice_tts` / `voice_list` **照常可用**，仅 `voice_stt` 不可用 |
| 网络 | 需能访问 Groq/OpenAI（必要时 `proxyUrl`） |

> **已知缺口**：`voice_stt` 只接受**音频文件**上传。手机上"按住说话"需要安卓麦克风桥
> （RecordAudio.kt + 桥方法 + 移动 UI 录音按钮），**本批未做**——现阶段的可用路径是
> 先用系统录音机录好、再把音频文件发给会话。要做的话见 `docs/AGENTS/known-gaps.md`。

---

## 5. 体积与合规

| 项 | 数值/说明 |
|---|---|
| 快照增量 | dsh-voice 2.6MB（261 文件）+ dsh-gsv-tts 1.5MB（93 文件），xz 后增量很小（纯 JS 文本） |
| 依赖随包自带 | `vendor/<pkg>/node_modules/`（干净解引用副本，无 .pnpm/symlink）——**不假设基座快照里有同名包** |
| 许可证 | 两插件 MIT；依赖 `edge-tts-universal` 为 **AGPL-3.0**（全文随包 LICENSE 分发，已登记 `THIRD_PARTY_NOTICES.md`，源码要约走既有 §源码要约流程） |
| ELF 门禁 | 纯 JS，无原生 binding，`elf-check` 无新增风险 |

---

## 6. 构建链改动清单（本批）

| 文件 | 改动 |
|---|---|
| `vendor/dsh-voice/`、`vendor/dsh-gsv-tts/` | 新增固化副本（package.json + lib/ + cordis.patch.yml + LICENSE + README + 自包含 node_modules/） |
| `scripts/inject-all.py` | ① external 注入支持 `node_modules/**`；② **修"部分存在"静默丢文件**——包已在快照但缺 node_modules 时，之前只走替换、依赖树被静默丢掉，现在补齐缺失文件 |
| `scripts/inject-external-plugins.py` | 同款 node_modules 支持（保持两脚本语义一致） |
| `scripts/build-apk.mjs`、`scripts/build-apk-013.ps1` | `--external` 追加 voice / gsvTts + 在场校验 |
| `scripts/profile-web.cordis.patch.yml` | 两个插件 insert + `provider: edge` 钉死 |
| `THIRD_PARTY_NOTICES.md` | 登记 7 个组件（含 AGPL 一条） |

> **镜像纪律**：`build-apk-013.ps1` 属协调仓镜像面——本仓已同步修改，**协调仓侧需同批镜像**
> （见 AGENTS.md §1 与 `check-patch-mirror.mjs` 纪律）。

---

## 7. 验证清单（本机已过）

- [x] `check-patch-mounts.mjs`：13 个注入包全部挂载（含 dsh-voice / dsh-gsv-tts）
- [x] 合成快照单 pass 注入：两插件 + 自包含 node_modules 全部落到
      `home/.dsh/profiles/web/node_modules/<pkg>/…`；权威 patch 正确装配（`provider: edge` 在场）
- [x] "部分存在"边界：包已在快照但缺 node_modules → 258 个缺失文件补齐（旧行为是静默丢）
- [x] 许可证扫描：6 依赖 + 2 插件全部登记，AGPL 一条全文在场
- [ ] **MuMu 模拟器实测**（用户定例的落地顺序）：设置 → 声音设置应出现"快速体验(Edge)"，
      点 🔊 能出声；`voice_list` 列出云端音色
- [ ] 真机（arm64）补充验证

---

## 8. 「本地模型 / ASR / TTS」可行性评估（2026-09-17 实测数据）

问题：手机上能不能不用云端、全部本地跑？结论分三档：

### 8.1 现状（本批集成后）

| 通道 | 状态 | 依赖 |
|---|---|---|
| TTS = Edge 云端 | ✅ 装完即用 | 联网 |
| ASR = Groq/OpenAI 云端 | ✅ 需 `DSH_VOICE_ASR_KEY` | 联网 + key |
| TTS = 本地 GSV-TTS-Lite | ❌ **已锁死**（`provider: edge`） | 见下 |

### 8.2 为什么本地 GSV 不建议上手机（实测数字）

桌面这套 GSV-TTS-Lite 的真实占用：

| 项 | 体积 |
|---|---|
| 引擎代码 | 9.7MB |
| **模型** | **657MB**（s1v3.ckpt 148M + s2Gv2ProPlus.pth 191M + chinese-hubert 180M + sv 103M + g2p 36M）|
| **Python venv** | **1.5GB**（torch 2.14 + transformers + onnxruntime + pyopenjtalk…）|
| 合计 | **≈2.2GB** |

再加三层硬伤：Termux 的 `python-torch` 是 CPU 版且兼容性看运气；GSV 推理链
（HuBERT→SoVITS→Vocoder）在手机 CPU 上 RTF 估 5~20 倍实时（10 秒的话等几十秒到几分钟）；
连续推理发热明显。**判定：技术上勉强、产品上不可用。**

### 8.3 可行的"本地化"路线（按性价比排序）

| 路线 | 改动量 | 体积 | 说明 |
|---|---|---|---|
| **本地 ASR：whisper.cpp 跑在 Termux** | **最小**（零插件改动） | 模型 40~150MB（tiny/base int8） | Termux 里跑 whisper.cpp + 一个 OpenAI 兼容小 shim（~百行），dsh-voice 的 `asrBaseUrl` 指到 `http://127.0.0.1:<port>/v1` 即可；壳侧麦克风链路（getUserMedia 授权）已就绪 |
| **本地 TTS：MOSS-TTS-Nano ONNX（0.1B）** | 中（要给 dsh-gsv-tts 加一个 provider，或起本地 HTTP 服务再配 `apiUrl`） | 模型 ~100-400MB + onnxruntime | CPU 实时设计、单核可跑；`~/feyanggit/moss-tts-nano` 本地已有工程（ONNX 版推理免 torch；注意部分脚本仍 import torch）；另有 **MOSS-TTS-Nano-Reader 直接在浏览器跑** —— 走 WebView WASM 的话连 Termux 都不需要 |
| GSV-TTS-Lite 原样 | — | 2.2GB | 不建议（见 8.2） |

**建议顺序**：先做本地 ASR（whisper.cpp，改动最小、离线收益最直接）；本地 TTS 等
MOSS-TTS-Nano 的浏览器/ONNX 路线更成熟再评估，期间用 Edge 云端顶住。

### 8.1 本地 ASR 已落地（2026-09-17 第二批）：dsh-local-asr

按 8.3 的最小改动路线落地：

| 组件 | 实现 |
|---|---|
| **whisper.cpp 二进制** | NDK 25.1.8937393 交叉编译（arm64-v8a + x86_64，android-26，Release，GGML_OPENMP=OFF），只依赖系统 libc/libm/libdl；随包在 `lib/bin/whisper-cli-<abi>` |
| **本地服务** | 零依赖 Node HTTP，`127.0.0.1:8941`，`POST /v1/audio/transcriptions`（multipart，手写解析器）→ spawn whisper-cli → OpenAI 格式 `{text}`；音频格式 mp3/flac/ogg/wav 全支持（内建 miniaudio + 自动重采样 16k），无需 ffmpeg |
| **模型 bootstrap** | `voice_local_bootstrap` 工具下载 ggml 模型（hf-mirror 优先、huggingface 回退，.part 原子改名）；默认 `base-q5_1` ≈ 60MB，中文要求高选 `small-q5_1` ≈ 190MB；模型落 `HOME/.dsh/local-asr/models/`（随应用数据持久化） |
| **dsh-voice 接线** | 权威 patch：`asrEngine: custom` + `asrBaseUrl: http://127.0.0.1:8941/v1` + `asrApiKey: local`（占位，插件校验要求非空）+ `asrModel: base-q5_1` |
| **ABI 裁剪** | 快照按 ABI 分包，构建时 `stageLocalAsr()` 只装对应架构的 whisper 二进制（省 ~23MB） |

**首次使用**：装机后跑一次 `voice_local_bootstrap`（约 60MB 下载，之后离线可用）；
`voice_local_status` 随时查三件事（二进制/模型/服务）各自就绪与否。

**已知边界**：whisper 手机 CPU 推理速度有限（base-q5_1 上短句秒级、长音频按分钟计）；
`whisper-server` 常驻模式未用（每请求 spawn 进程更稳）；流式（边说边转）未做，需 VAD + 分段。

**构建产物**：`out/dsh-mobile-voice-debug-arm64.apk`（173.8MB，内嵌快照 sha256 374091f1…），
构建链 `node scripts/build-apk.mjs --abi arm64 --suffix "-voice" --snapshot <快照>`，
门禁：挂载集 14/14 ✓、机密 ✓、ELF ✓；**第三方许可门禁未过（既有缺口）**——
快照源缺 `usr/share/LICENSES/` 全文（Termux 包 copyright 符号链接悬空），
未注入的原始快照同样报错，与本批改动无关，需另行补快照源的 LICENSES 装配。
