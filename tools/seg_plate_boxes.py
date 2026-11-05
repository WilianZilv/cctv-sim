"""The character segmentation dataset with what the reader needs of the plate type,
twice: on every character box and on one box around the whole plate (which sees the
Mercosul band, the old plates' city strip, the coloured background).

    0 mercosul           characters of a Mercosul plate (any ink colour: always dark on white)
    1 antiga             characters of an old-style plate
    2 antiga_invertida   characters of an old red / green plate (white on colour: invert before the OCR)
    3 placa_mercosul     the whole plate
    4 placa_antiga
    5 placa_antiga_invertida

Character boxes get room around the glyph (tools/char_boxes.py), as the generator now
writes them. Illegible plates (tools/plate_quality.py made them negatives) keep the
plate box and get no character boxes: a plate, of that type, that cannot be read. Not-a-plate
samples stay empty. Images are hard links to the 6-type dataset. Re-runnable.

    uv run python tools/seg_plate_boxes.py dataset/2_char_segmentation dataset/2_char_segmentation_plate
"""
import json
import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from char_boxes import roomy_chars  # noqa: E402

TYPE = {"mercosul": 0, "mercosul_vermelha": 0, "mercosul_verde": 0, "antiga": 1, "antiga_vermelha": 2, "antiga_verde": 2}
NAMES = ["mercosul", "antiga", "antiga_invertida", "placa_mercosul", "placa_antiga", "placa_antiga_invertida"]
S = 320


def main(src, dst):
    src, dst = Path(src), Path(dst)
    meta = {}
    for line in (src / "meta.jsonl").read_text(encoding="utf8").splitlines():
        try:
            m = json.loads(line)
            meta[m["name"]] = m
        except json.JSONDecodeError:
            pass
    if dst.exists():
        shutil.rmtree(dst)
    counts = [0] * len(NAMES)
    for split in ("train", "val"):
        (dst / "images" / split).mkdir(parents=True)
        (dst / "labels" / split).mkdir(parents=True)
        for img in (src / "images" / split).glob("*.jpg"):
            os.link(img, dst / "images" / split / img.name)
            m = meta.get(img.stem, {})
            out = []
            if not m.get("negative") and m.get("plateType"):
                lab = src / "labels" / split / (img.stem + ".txt")
                # character boxes only where the plate kept them (an illegible one has
                # none), each with room around the glyph (tools/char_boxes.py)
                if lab.exists() and lab.read_text(encoding="utf8").strip():
                    for ch, cx, cy, w, h in roomy_chars(m):
                        out.append(f"{TYPE[m['plateType']]} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")
                ox, oy, pw, ph = m["letterbox"]
                out.append(f"{3 + TYPE[m['plateType']]} {(ox + pw / 2) / S:.6f} {(oy + ph / 2) / S:.6f} {pw / S:.6f} {ph / S:.6f}")
            for l in out:
                counts[int(l.split()[0])] += 1
            (dst / "labels" / split / (img.stem + ".txt")).write_text("\n".join(out) + ("\n" if out else ""), encoding="utf8")
    (dst / "data.yaml").write_text("\n".join([
        "# Rectified plates from cctv-sim: a box per character and one around the plate, each",
        "# classed with what the reader needs of the plate type (tools/seg_plate_boxes.py)",
        f"path: {dst.resolve().as_posix()}", "train: images/train", "val: images/val", "", "names:",
        *[f"  {i}: {c}" for i, c in enumerate(NAMES)], ""]), encoding="utf8")
    print(dst, {n: c for n, c in zip(NAMES, counts)})


if __name__ == "__main__":
    main(*sys.argv[1:3])
