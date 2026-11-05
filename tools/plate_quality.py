"""Legibility of each plate in a character-segmentation dataset (tools/dataset.mjs --task chars).

Every character box is compared against clean glyphs of the plate's own font
(template matching, TM_CCOEFF_NORMED, glyph kept at its aspect, box height 32 px,
best of a few slants; the ink polarity is flipped when that looks more glyph-like):

    margin = score(true char) - best score(any other char of the same family)
    top    = best score of any char of the family (label-free "is there a glyph?")

(26 letters for a letter, 10 digits for a digit). A low margin means the crop
looks at least as much like another character as like its own. Per plate:

    legivel   >= --plate-good chars with margin >= --char-bad and median margin
              >= --char-good                               -> kept as is
    ilegivel  >= --plate-bad chars with margin < --char-bad and median top
              < --plate-top (no sharp glyph at the boxes)  -> no character boxes (only
                                                              the whole-plate box, in datasets
                                                              that have one)
    cinza     everything else                              -> kept as is (hard but
                                                              labelled right: its boxes are exact
                                                              and the type's colour shows); with
                                                              --exclude-gray moved to
                                                              excluded/{images,labels}/<split>/

Results live in <seg_dir>/quality.jsonl (one JSON per plate: margins, predicted
char, band, the original label lines). Incremental: only plates not yet in it are
scored, so it can follow a generation that is still appending to meta.jsonl
(meta.jsonl is only read). Applying is a reconciliation with the current bands
(the original labels are kept in quality.jsonl), so re-running with other
thresholds moves plates back and forth correctly. Samples with `negative: true`
are recorded and left untouched.

    uv run --with opencv-python-headless --with pillow --with numpy python tools/plate_quality.py dataset/2_char_segmentation
    [--char-bad 0.02] [--char-good 0.06] [--plate-good 6] [--plate-bad 4] [--plate-top 0.55]
    [--dry-run] [--workers N]
"""
import argparse
import json
import os
import statistics
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
from char_boxes import tight_chars  # noqa: E402  (the metric needs the glyph's own box)

ROOT = Path(__file__).resolve().parent.parent
FONTS = {"mercosul": ROOT / "assets/plates/mercosul_fonte.ttf", "antiga": ROOT / "assets/plates/antiga_fonte.ttf"}
LET, DIG = "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "0123456789"
INVERTED = {"antiga_vermelha", "antiga_verde"}
H = 32      # template height
SLACK = 2   # px of slack around the box, at template scale
FLIP_BELOW = 0.6  # median best-glyph score under which the other ink polarity is tried
SHEARS = (-0.3, -0.15, 0.0, 0.15, 0.3)  # every candidate gets its best slant

_GLYPHS = None
_TEMPL = {}


def glyph(font_path, ch):
    f = ImageFont.truetype(str(font_path), 200)
    im = Image.new("L", (300, 300), 255)
    ImageDraw.Draw(im).text((50, 20), ch, font=f, fill=0)
    a = np.array(im)
    ys, xs = np.where(a < 128)
    return a[ys.min():ys.max() + 1, xs.min():xs.max() + 1].astype(np.float32)


def glyphs():
    global _GLYPHS
    if _GLYPHS is None:
        _GLYPHS = {s: {c: glyph(p, c) for c in LET + DIG} for s, p in FONTS.items()}
    return _GLYPHS


def template(style, c, tw, k=0.0):
    """Glyph at height H keeping its aspect, centred on a white tw-wide canvas,
    sheared by k (x += k * (y - H/2)): rectified plates keep some slant."""
    key = (style, c, tw, k)
    t = _TEMPL.get(key)
    if t is None:
        g = glyphs()[style][c]
        gw = min(tw, max(2, round(g.shape[1] * H / g.shape[0])))
        t = np.full((H, tw), 255, np.float32)
        t[:, (tw - gw) // 2:(tw - gw) // 2 + gw] = cv2.resize(g, (gw, H), interpolation=cv2.INTER_AREA)
        if k:
            M = np.float32([[1, k, -k * H / 2], [0, 1, 0]])
            t = cv2.warpAffine(t, M, (tw, H), flags=cv2.INTER_LINEAR, borderValue=255)
        _TEMPL[key] = t
    return t


def char_margin(gray, box, style, ch):
    """(margin, best other char, best score of any char of the family) for one
    character box (pixel x0, y0, x1, y1)."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    if w < 1 or h < 1:
        return -1.0, "?", 0.0
    s = H / h
    tw = max(6, round(w * s))
    pr = max(1, round(SLACK / s))
    reg = gray[max(0, y0 - pr):y1 + pr, max(0, x0 - pr):x1 + pr]
    if reg.size == 0:
        return -1.0, "?", 0.0
    reg = cv2.resize(reg, (tw + 2 * SLACK, H + 2 * SLACK), interpolation=cv2.INTER_AREA)
    family = LET if ch in LET else DIG
    if ch not in family:
        return -1.0, "?", 0.0
    res = {c: max(float(cv2.matchTemplate(reg, template(style, c, tw, k), cv2.TM_CCOEFF_NORMED).max()) for k in SHEARS)
           for c in family}
    other = max((c for c in family if c != ch), key=res.get)
    return res[ch] - res[other], other, max(res.values())


def find_image(seg, m):
    """Current path of the sample's image: images/<split>/ or excluded/images/<split>/."""
    p = seg / m["file"]
    if p.exists():
        return p
    p = seg / "excluded" / m["file"]
    return p if p.exists() else None


def score_plate(args):
    seg, m = args
    path = find_image(Path(seg), m)
    if path is None:
        return None  # not written yet; retried next run
    try:
        img = np.array(Image.open(path).convert("L")).astype(np.float32)
    except OSError:
        return None  # being written right now
    if m["plateType"] in INVERTED:
        img = 255 - img
    style = "mercosul" if m["plateType"].startswith("mercosul") else "antiga"
    r = score_chars(img, tight_chars(m), style)
    if statistics.median(r[2]) < FLIP_BELOW:
        # wear / exposure can turn the ink polarity around (red ink on a washed-out
        # plate reads dark on light); keep whichever polarity looks more like
        # characters at all (best score of any glyph: label-free)
        r2 = score_chars(255 - img, tight_chars(m), style)
        if statistics.median(r2[2]) > statistics.median(r[2]):
            r = r2 + (True,)
    out = {"name": m["name"], "file": m["file"], "plateType": m["plateType"],
           "chars": "".join(c[0] for c in m["chars"]), "margins": r[0], "pred": "".join(r[1]), "top": r[2]}
    if len(r) > 3:
        out["flipped"] = True
    return out


def score_chars(img, chars, style):
    W, Hh = img.shape[1], img.shape[0]
    margins, preds, tops = [], [], []
    for ch, cx, cy, w, h in chars:
        box = [round((cx - w / 2) * W), round((cy - h / 2) * Hh), round((cx + w / 2) * W), round((cy + h / 2) * Hh)]
        mg, pred, top = char_margin(img, box, style, ch.upper())
        margins.append(round(mg, 4))
        preds.append(pred)
        tops.append(round(top, 3))
    return margins, preds, tops


def band(q, a):
    m = q["margins"]
    if not m:
        return "ilegivel"
    bad = sum(x < a.char_bad for x in m)
    if len(m) - bad >= min(a.plate_good, len(m)) and statistics.median(m) >= a.char_good:
        return "legivel"
    # many chars that do not match their label AND no crisp glyph of any kind at
    # the boxes: blur / noise / no plate. A plate whose boxes hold sharp glyphs
    # that just don't match (slant, box offset, odd rendering) is not unreadable:
    # it stays grey and is excluded, never taught as "nothing here".
    if bad >= a.plate_bad and statistics.median(q.get("top") or [0]) < a.plate_top:
        return "ilegivel"
    return "cinza"


def read_jsonl(p):
    out = []
    if p.exists():
        for line in p.read_text(encoding="utf8").splitlines():
            if not line.strip():
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue  # partial last line
    return out


def move(src, dst):
    if src.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        os.replace(src, dst)


def apply(seg, q, meta, exclude_gray=False, plate_box=False):
    """Put the sample where its band says. Returns the action taken (or None)."""
    split = q["file"].split("/")[1]
    img_in, img_ex = seg / q["file"], seg / "excluded" / q["file"]
    lab_rel = Path("labels") / split / (q["name"] + ".txt")
    lab_in, lab_ex = seg / lab_rel, seg / "excluded" / lab_rel
    lines = q.get("label")
    if lines is None:  # first time: remember the original label lines
        for p in (lab_in, lab_ex):
            if p.exists() and p.read_text(encoding="utf8").strip():
                lines = p.read_text(encoding="utf8").strip().splitlines()
                break
        else:
            lines = meta.get("labels")
        if lines is None:
            return None  # label not written yet
        q["label"] = lines
    want = q["band"]
    act = None
    if want == "cinza" and exclude_gray:
        if img_in.exists() or lab_in.exists():
            move(img_in, img_ex)
            move(lab_in, lab_ex)
            act = "excluida"
        return act
    # legivel / ilegivel: back in images/labels
    if img_ex.exists() or lab_ex.exists():
        move(img_ex, img_in)
        move(lab_ex, lab_in)
        act = "restaurada"
    # an illegible plate loses its character boxes; in datasets with a box around the
    # whole plate (classes 3-5) that one stays: a plate, of that type, unreadable
    keep = [l for l in lines if plate_box and int(l.split()[0]) >= 3] if want == "ilegivel" else lines
    text = "\n".join(keep) + "\n" if keep else ""
    cur = lab_in.read_text(encoding="utf8") if lab_in.exists() else None
    if cur is None or cur.strip() != text.strip():
        lab_in.parent.mkdir(parents=True, exist_ok=True)
        lab_in.write_text(text, encoding="utf8")
        act = act or "restaurada"
    if act and want == "ilegivel":
        act = "negativa"
    return act


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("seg", help="character segmentation dataset (meta.jsonl, images/, labels/)")
    ap.add_argument("--char-bad", type=float, default=0.02, help="char margin below this = unreadable")
    ap.add_argument("--char-good", type=float, default=0.06, help="median char margin of a legible plate")
    ap.add_argument("--plate-bad", type=int, default=4, help="this many unreadable chars (and --plate-top) = illegible plate")
    ap.add_argument("--plate-top", type=float, default=0.55,
                    help="illegible only if the median best-glyph score of its boxes is below this")
    ap.add_argument("--plate-good", type=int, default=6, help="readable chars needed for a legible plate")
    ap.add_argument("--exclude-gray", action="store_true", help="move grey-band plates out of the dataset instead of keeping them")
    ap.add_argument("--dry-run", action="store_true", help="score and report, move nothing")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    a = ap.parse_args()
    seg = Path(a.seg)

    # datasets written since the whole-plate box have classes placa_* in data.yaml
    yaml = seg / "data.yaml"
    plate_box = yaml.exists() and "placa_mercosul" in yaml.read_text(encoding="utf8")
    meta = {}
    for m in read_jsonl(seg / "meta.jsonl"):
        meta[m["name"]] = m
    qpath = seg / "quality.jsonl"
    quality = {q["name"]: q for q in read_jsonl(qpath)}

    todo = [m for n, m in meta.items() if n not in quality]
    neg = [m for m in todo if m.get("negative")]
    for m in neg:
        quality[m["name"]] = {"name": m["name"], "file": m["file"], "negative": True}
    todo = [(str(seg), m) for m in todo if not m.get("negative")]
    new = 0
    if todo:
        with ProcessPoolExecutor(a.workers) as ex:
            for i, r in enumerate(ex.map(score_plate, todo, chunksize=64)):
                if r:
                    quality[r["name"]] = r
                    new += 1
                if (i + 1) % 2000 == 0:
                    print(f"  {i + 1}/{len(todo)} placas pontuadas", flush=True)

    acts = {}
    for q in quality.values():
        if q.get("negative"):
            continue
        q["band"] = band(q, a)
        if not a.dry_run:
            act = apply(seg, q, meta.get(q["name"], {}), a.exclude_gray, plate_box)
            if act:
                acts[act] = acts.get(act, 0) + 1

    if not a.dry_run or new:
        tmp = qpath.with_suffix(".jsonl.tmp")
        tmp.write_text("".join(json.dumps(q, ensure_ascii=False) + "\n" for q in quality.values()), encoding="utf8")
        os.replace(tmp, qpath)

    plates = [q for q in quality.values() if not q.get("negative")]
    n = len(plates) or 1
    chars = [x for q in plates for x in q["margins"]]
    nc = len(chars) or 1
    print(f"{new} placas novas pontuadas, {len(neg)} negativas novas; {len(plates)} placas em quality.jsonl")
    print(f"limiares: char-bad {a.char_bad}  char-good {a.char_good}  plate-bad {a.plate_bad}  "
          f"plate-top {a.plate_top}  plate-good {a.plate_good}")
    print(f"caracteres: {100 * sum(x < a.char_bad for x in chars) / nc:.1f}% < char-bad, "
          f"{100 * sum(a.char_bad <= x < a.char_good for x in chars) / nc:.1f}% zona cinza, "
          f"{100 * sum(x >= a.char_good for x in chars) / nc:.1f}% >= char-good")
    for b, what in (("legivel", "mantidas"), ("cinza", "-> excluded/" if a.exclude_gray else "mantidas (dificeis)"), ("ilegivel", "-> sem caixas de caractere" + (" (só a da placa)" if plate_box else ""))):
        k = sum(q["band"] == b for q in plates)
        print(f"  {b:9s} {k:6d}  {100 * k / n:5.1f}%  {what}")
    if a.dry_run:
        print("(--dry-run: nada movido)")
    else:
        print("ações desta rodada:", ", ".join(f"{v} {k}" for k, v in sorted(acts.items())) or "nenhuma")


if __name__ == "__main__":
    main()
