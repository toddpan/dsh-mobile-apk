'use strict';
/**
 * asr-worker.cjs（移动端 Termux 适配版，2026-09-20）
 *
 * 上游插件 dsh-prompt-enhancer 的本地 ASR worker（lib/asr-worker.cjs）依赖 node 版
 * sherpa-onnx NAPI 预编译包（glibc/linux-arm64），在 Android Termux（bionic libc）下
 * dlopen 必败。本文件保持与上游完全一致的 HTTP 契约，仅把推理实现换成官方
 * sherpa-onnx Termux 构建（k2-fsa releases，NDK/Termux toolchain，bionic 原生）的
 * sherpa-onnx-offline CLI：每次识别 spawn 子进程 → 解析 stdout 文本。
 *
 * 契约（与上游一致，host lib/asr.cjs 消费）：
 *   GET  /health  → {ok:true, modelReady, model}
 *   POST /rpc     {method:'status'}                → {ok, modelReady, model, modelFile, tokensFile, loadError}
 *   POST /rpc     {method:'transcribe', args:{audioBase64(dataURL), language}} → {ok, text} / {ok:false, code}
 * 端口：固定 3082；EADDRINUSE → 动态口 fallback + worker.port 文件（上游 host 兼容）。
 * 附加：worker.pid 文件（自报 pid，供 host restartWorker 精准杀旧进程——netstat -ano
 * 是 Windows 专用语法/输出，Termux 上探活改由 host 侧 TCP connect 探测，见 asr-models.cjs 补丁）。
 *
 * 模型布局不变：models/<id>/model.int8.onnx + tokens.txt（与上游下载/清单机制互认）。
 * 二进制随包：<runtime>/bin/sherpa-onnx-offline + <runtime>/lib/*.so（构建期按 ABI 裁剪）。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 3082;
const MODEL_ID = process.env.DSH_ASR_MODEL || 'sense-voice';
const MODEL_TYPE = process.env.DSH_ASR_MODEL_TYPE || null;
const MODEL_DIR = path.join(__dirname, 'models', MODEL_ID);
const BIN = path.join(__dirname, 'bin', 'sherpa-onnx-offline');
const LIB_DIR = path.join(__dirname, 'lib');
// [移动端 2026-09-20] 不用 os.tmpdir()：Termux node 把 tmpdir 烧死在 com.termux 前缀
// （本 app 域不可见，ENOENT）。音频中转文件放运行时目录自带 tmp/（app 数据区必可写）。
const TMP_DIR = path.join(__dirname, 'tmp');
try { fs.mkdirSync(TMP_DIR, { recursive: true }); } catch (e) { /* ignore */ }
const VOICE_LANGS = ['auto', 'zh', 'en', 'ja', 'ko', 'yue'];
function normLang(l) { return VOICE_LANGS.indexOf(l) >= 0 ? l : 'auto'; }

/** [移动端 2026-09-20 实测修正] LD_LIBRARY_PATH 只含运行时 lib/（CLI 依赖 libc++_shared.so 已随包
 *  打进该目录，onnxruntime/sherpa 的 .so 同目录；RUNPATH 的 $ORIGIN/../lib 也落在同处）。
 *  **不能**把 Termux usr/lib 加进来：会把系统库解析劫持到 Termux 版（实测 API 35 上
 *  /system/lib64/libunwindstack.so 的 Xzs_Construct 因此找不到，CLI 直接起不来）；
 *  继承的引擎 LD_LIBRARY_PATH 同样舍弃，避免同类劫持。 */
function buildLdLibraryPath() {
  return LIB_DIR;
}

function modelFiles() {
  let onnx = null;
  try { onnx = fs.readdirSync(MODEL_DIR).find((f) => /\.onnx$/i.test(f)) || null; } catch (e) { /* 目录缺失 */ }
  const tokens = path.join(MODEL_DIR, 'tokens.txt');
  return { onnx: onnx ? path.join(MODEL_DIR, onnx) : null, tokens: fs.existsSync(tokens) ? tokens : null };
}

function status() {
  const { onnx, tokens } = modelFiles();
  const binOk = fs.existsSync(BIN);
  return {
    ok: true,
    modelReady: !!(onnx && tokens && binOk),
    model: MODEL_ID,
    modelFile: !!onnx,
    tokensFile: !!tokens,
    cliFile: binOk,
    loadError: (!onnx || !tokens) ? 'model-missing: ' + MODEL_DIR : (binOk ? null : 'cli-missing: ' + BIN),
  };
}

/** 解析 sherpa-onnx-offline 输出：优先 JSON 行 {"text": …}，退回「Text: …」行，再退回最后非空行（剥时间戳前缀） */
function parseCliText(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\{"[\s\S]*\}$/.exec(lines[i]);
    if (m) {
      try {
        const o = JSON.parse(m[0]);
        if (typeof o.text === 'string') return o.text.trim();
      } catch (e) { /* 非法 JSON 继续 */ }
    }
    const t = /^Text:\s*(.*)$/.exec(lines[i]);
    if (t) return t[1].trim();
  }
  const last = lines[lines.length - 1] || '';
  return last.replace(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[.,]\d{3}\s*/, '').trim();
}

function transcribe(dataUrl, lang) {
  const st = status();
  if (!st.modelReady) {
    return { ok: false, code: 'ASR_LOCAL_MODEL_NOT_READY', message: st.loadError || 'recognizer not ready' };
  }
  if (typeof dataUrl !== 'string' || !/^data:audio\/(wav|mp3);base64,/.test(dataUrl)) {
    return { ok: false, code: 'BAD_AUDIO' };
  }
  const { onnx, tokens } = modelFiles();
  const ext = /\.mp3$/i.test(dataUrl.slice(0, 40)) || dataUrl.startsWith('data:audio/mp3') ? 'mp3' : 'wav';
  const tmp = path.join(TMP_DIR, 'pe-asr-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.' + ext);
  const args = [
    '--tokens=' + tokens,
    MODEL_TYPE === 'paraformer'
      ? '--paraformer=' + onnx
      : '--sense-voice-model=' + onnx,
    '--sense-voice-language=' + normLang(lang),
    '--sense-voice-use-itn=1',
    tmp,
  ];
  try {
    fs.writeFileSync(tmp, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
    const r = spawnSyncClamped(BIN, args);
    if (r.error) return { ok: false, code: 'ASR_LOCAL_FAILED', message: String(r.error.message || r.error).slice(0, 200) };
    if (r.status !== 0) {
      return { ok: false, code: 'ASR_LOCAL_FAILED', message: ('exit ' + r.status + ': ' + String(r.stderr || '').slice(-200)).trim() };
    }
    const text = parseCliText(r.stdout);
    if (!text) return { ok: false, code: 'ASR_LOCAL_FAILED', message: 'empty transcription' };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, code: 'ASR_LOCAL_FAILED', message: ((e && e.message) || String(e)).slice(0, 200) };
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  }
}

/** 同步 spawn（worker 独立进程内阻塞无妨；上限 90s 防 hang 死进程堆积） */
function spawnSyncClamped(bin, args) {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(bin, args, {
    timeout: 90 * 1000,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { LD_LIBRARY_PATH: buildLdLibraryPath() }),
  });
  return r;
}

function handleRequest(req, res) {
  if (req.method === 'POST' && (req.url === '/rpc' || req.url === '/rpc/')) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { /* 非法 body */ }
      const method = parsed && parsed.method;
      const args = parsed && parsed.args && typeof parsed.args === 'object' ? parsed.args : {};
      let result;
      try {
        if (method === 'status') result = status();
        else if (method === 'transcribe') result = transcribe(args.audioBase64, args.language);
        else result = { ok: false, code: 'BAD_METHOD' };
      } catch (e) {
        result = { ok: false, code: 'ASR_LOCAL_FAILED', message: String((e && e.message) || e).slice(0, 200) };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/health/')) {
    const st = status();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, modelReady: st.modelReady, model: st.model }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, code: 'NOT_FOUND' }));
}

const server = http.createServer(handleRequest);

function writeMeta(file, obj) {
  try { fs.writeFileSync(path.join(__dirname, file), JSON.stringify(obj), 'utf8'); } catch (e) { /* ignore */ }
}

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    // 固定口被占（可能上一个 worker 仍在）：动态口 fallback + worker.port 文件（上游 host 兼容读取）
    const dyn = http.createServer(handleRequest);
    dyn.listen(0, '127.0.0.1', () => {
      const port = dyn.address().port;
      writeMeta('worker.port', { port, pid: process.pid, at: Date.now() });
      writeMeta('worker.pid', { pid: process.pid, port });
    });
    return;
  }
  throw e;
});

server.listen(PORT, '127.0.0.1', () => {
  // 固定口绑定成功：清掉可能存在的动态口残留文件，让 host 用默认 3082
  try { fs.unlinkSync(path.join(__dirname, 'worker.port')); } catch (e) { /* ignore */ }
  writeMeta('worker.pid', { pid: process.pid, port: PORT });
});
