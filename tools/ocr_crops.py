"""Character OCR datasets from a rectified-plate dataset (tools/dataset.mjs --task chars).

Four single-character classifiers, each an Ultralytics classify dataset
(<set>/{train,val}/<class>/<name>.jpg):

    alfa_mercosul   A-Z   Mercosul plates (black, red and green ink)
    alfa_antiga     A-Z   old-style plates; the inverted ones (red / green, white
                          characters) inverted back to dark on light, as the reader
                          will do at predict time (it knows the plate type)
    num_mercosul    0-9
    num_antiga      0-9

Each character is cut from the rectified plate with a random margin and offset
(the segmentation model's boxes are not exact), then fitted into a square on grey.

Legibility: the label itself is always right (the generator drew it); the question
is only whether a person could read the crop. A logistic model, fitted to a
by-eye audit of crops around the decision boundary (tools/ocr_legibility.json),
gives p(legible) from the character's template-matching margin and top score
(<src>/quality.jsonl, from tools/plate_quality.py: run it first), its height in
the camera frame and the plate's contrast:

    p >= p_class   -> its own class
    p <  p_unk     -> `unk` of that character's set (the reject class: "can't read this")
    anything else  -> skipped (ambiguous)

Plates plate_quality.py moved to excluded/ or turned into negatives still give
their characters (the image is looked up in excluded/ too); samples generated as
`negative` (no plate) are skipped. Re-runnable: crops already written are skipped,
so it can follow a generation that is still going (plates not scored yet wait for
the next run).

    uv run --with pillow python tools/ocr_crops.py dataset/2_char_segmentation dataset/3_char_ocr
    [--size 64] [--model tools/ocr_legibility.json] [--p-class 0.75] [--p-unk 0.35]
"""
import argparse
import json
import math
import random
import sys
from pathlib import Path

from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).parent))
from char_boxes import roomy_chars, tight_chars  # noqa: E402  (crops around the roomy boxes)

INVERTED = {"antiga_vermelha", "antiga_verde"}
UNK = "unk"


def crop_box(cx, cy, w, h, W, H, rng):
    # margin 3-15% of the box on each side, centre off by up to 6%
    mx = w * rng.uniform(0.03, 0.15)
    my = h * rng.uniform(0.03, 0.15)
    cx += w * rng.uniform(-0.06, 0.06)
    cy += h * rng.uniform(-0.06, 0.06)
    x0, x1 = max(0, cx - w / 2 - mx), min(W, cx + w / 2 + mx)
    y0, y1 = max(0, cy - h / 2 - my), min(H, cy + h / 2 + my)
    return round(x0), round(y0), round(x1), round(y1)


def letterbox(img, size):
    w, h = img.size
    s = size / max(w, h)
    img = img.resize((max(1, round(w * s)), max(1, round(h * s))), Image.BILINEAR)
    out = Image.new("RGB", (size, size), (114, 114, 114))
    out.paste(img, ((size - img.width) // 2, (size - img.height) // 2))
    return out


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="rectified-plate dataset (meta.jsonl, images/)")
    ap.add_argument("out", help="where the four OCR datasets go")
    ap.add_argument("--size", type=int, default=64, help="square crop side (px)")
    ap.add_argument("--quality", type=int, default=95, help="JPEG quality")
    ap.add_argument("--model", default=str(Path(__file__).with_name("ocr_legibility.json")), help="fitted legibility model")
    ap.add_argument("--p-class", type=float, help="p(legible) from this up -> its class (default: the model's)")
    ap.add_argument("--p-unk", type=float, help="p(legible) below this -> unk (default: the model's)")
    args = ap.parse_args()
    src, out = Path(args.src), Path(args.out)

    qpath = src / "quality.jsonl"
    if not qpath.exists():
        sys.exit(f"{qpath} não existe: rode antes\n"
                 f"  uv run --with opencv-python-headless --with pillow --with numpy python tools/plate_quality.py {args.src}")
    quality = {}
    for line in qpath.read_text(encoding="utf8").splitlines():
        try:
            q = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "margins" in q:
            quality[q["name"]] = (q["margins"], q["top"])

    lm = json.loads(Path(args.model).read_text(encoding="utf8"))
    p_class = args.p_class if args.p_class is not None else lm["p_class"]
    p_unk = args.p_unk if args.p_unk is not None else lm["p_unk"]

    def legible(mg, top, src_h, char_std):
        x = [mg, top, mg * top, math.log(max(src_h, 1.0)), char_std]
        z = lm["intercept"] + sum(c * (v - mu) / sd for c, v, mu, sd in zip(lm["coef"], x, lm["mean"], lm["std"]))
        return 1 / (1 + math.exp(-z))

    written = skipped = gray = unk = unscored = 0
    for line in (src / "meta.jsonl").read_text(encoding="utf8").splitlines():
        if not line.strip():
            continue
        try:
            m = json.loads(line)
        except json.JSONDecodeError:
            continue  # the generator's line being written right now
        if m.get("negative") or not m.get("chars"):
            continue
        margins, tops = quality.get(m["name"], (None, None))
        if margins is None or len(margins) != len(m["chars"]):
            unscored += 1
            continue
        split = m["file"].split("/")[1]
        # plate height in the camera frame: the character's own height there
        c = m["plateSide"]["corners"]
        plate_h = (math.dist(c[0], c[3]) + math.dist(c[1], c[2])) / 2
        ph = m["letterbox"][3] / 320
        style = "mercosul" if m["plateType"].startswith("mercosul") else "antiga"
        img = None
        tight = tight_chars(m)
        for i, (ch, cx, cy, w, h) in enumerate(roomy_chars(m)):
            kind = "num" if ch.isdigit() else "alfa"
            # (the legibility model was fitted on the glyph's own height)
            p = legible(margins[i], tops[i], tight[i][4] / ph * plate_h, m.get("charStd", 0))
            if p >= p_class:
                cls = ch
            elif p < p_unk:
                cls = UNK
                unk += 1
            else:
                gray += 1
                continue
            dst = out / f"{kind}_{style}" / split / cls / f"{m['name']}_{i}.jpg"
            if dst.exists():
                skipped += 1
                continue
            if img is None:
                path = src / m["file"]
                if not path.exists():  # moved aside by plate_quality.py
                    path = src / "excluded" / m["file"]
                img = Image.open(path).convert("RGB")
                if m["plateType"] in INVERTED:
                    img = ImageOps.invert(img)
            W, H = img.size
            # same sample, same margins on every run
            rng = random.Random(f"{m['name']}/{i}")
            box = crop_box(cx * W, cy * H, w * W, h * H, W, H, rng)
            dst.parent.mkdir(parents=True, exist_ok=True)
            letterbox(img.crop(box), args.size).save(dst, quality=args.quality)
            written += 1

    print(f"{written} recortes novos, {skipped} já existiam; {unk} caracteres em unk, "
          f"{gray} ambíguos (pulados); {unscored} placas ainda sem nota em quality.jsonl")
    for d in sorted(p for p in out.iterdir() if p.is_dir()):
        n = {s: sum(1 for _ in (d / s).rglob("*.jpg")) for s in ("train", "val")}
        u = {s: sum(1 for _ in (d / s / UNK).glob("*.jpg")) for s in ("train", "val")}
        print(f"  {d.name}: {n['train']} treino ({u['train']} unk), {n['val']} validação ({u['val']} unk)")


if __name__ == "__main__":
    main()
