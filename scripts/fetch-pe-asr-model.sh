#!/usr/bin/env bash
# fetch-pe-asr-model.sh — 下载 dsh-prompt-enhancer 本地 ASR 的 SenseVoice 模型（构建前置）
#
# 模型不入库（239MB 超 GitHub 单文件上限；与 snapshot.tar.xz 同口径）：
#   vendor/dsh-prompt-enhancer-asr-runtime/home/.dsh/dsh-prompt-enhancer-asr/models/sense-voice/
#     ├── model.int8.onnx  (~228MB)
#     └── tokens.txt
# 缺文件时 build-apk.mjs 的在场校验会直接报错，先跑本脚本。
#
# 用法：bash scripts/fetch-pe-asr-model.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/vendor/dsh-prompt-enhancer-asr-runtime/home/.dsh/dsh-prompt-enhancer-asr/models/sense-voice"
REPO_DIR="sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
FILES=("model.int8.onnx" "tokens.txt")
MIRRORS=(
  "https://hf-mirror.com/csukuangfj/$REPO_DIR/resolve/main"
  "https://huggingface.co/csukuangfj/$REPO_DIR/resolve/main"
)

mkdir -p "$DIR"
for f in "${FILES[@]}"; do
  dest="$DIR/$f"
  if [ -s "$dest" ]; then
    echo "[skip] $f 已存在 ($(du -h "$dest" | cut -f1))"
    continue
  fi
  ok=0
  for m in "${MIRRORS[@]}"; do
    echo "[get] $m/$f"
    if curl -fL --retry 3 --retry-all-errors -C - -o "$dest.part" "$m/$f"; then
      mv "$dest.part" "$dest"
      ok=1
      break
    fi
    rm -f "$dest.part"
  done
  [ "$ok" = 1 ] || { echo "[fail] $f 所有源均失败"; exit 1; }
  echo "[ok] $f ($(du -h "$dest" | cut -f1))"
done
echo "模型就绪：$DIR"
