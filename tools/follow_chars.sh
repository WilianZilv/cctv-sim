#!/bin/bash
# While tools/dataset.mjs fills a rectified-plate dataset, keeps its legibility
# notes and the OCR datasets cut from it up to date (both steps are incremental).
#   bash tools/follow_chars.sh dataset/2_char_segmentation dataset/3_char_ocr dataset_both.log [600]
SEG=$1; OCR=$2; LOG=$3; EVERY=${4:-600}
cd "$(dirname "$0")/.."
step() {
  uv run --with opencv-python-headless --with pillow --with numpy python tools/plate_quality.py "$SEG" | tail -5
  uv run --with pillow python tools/ocr_crops.py "$SEG" "$OCR" | head -1
}
while ! grep -q "pronto:" "$LOG" 2>/dev/null; do
  echo "[$(date +%T)]"; step
  sleep "$EVERY"
done
echo "[$(date +%T)] geração terminou: passada final"; step
