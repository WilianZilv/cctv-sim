"""Character boxes of a rectified-plate sample, tight or with room around them.

The generator (src/gen.js, charPad) writes each character's label box with a little
room around the glyph (the stroke's soft edge, the stamped relief's bevel) and says so
in meta.boxPad. Samples written before that have the glyph's tight box. These two
functions give either kind from either sample: the OCR crops and the character
labels use the roomy box, the legibility metric (template matching against the font)
the tight one.

chars: [[ch, cx, cy, w, h], ...] normalised to the 320 square; letterbox [ox, oy, pw, ph].
"""
PAD = (0.05, 0.04)   # share of the glyph box's width / height on each side, as src/gen.js charPad
S = 320


def roomy_chars(m, pad=PAD):
    """The character boxes with room around them (as they are when meta.boxPad is set)."""
    if m.get("boxPad"):
        return m["chars"]
    ox, oy, pw, ph = m["letterbox"]
    out = []
    for ch, cx, cy, w, h in m["chars"]:
        x0, x1 = (cx - w / 2) * S, (cx + w / 2) * S
        y0, y1 = (cy - h / 2) * S, (cy + h / 2) * S
        bx0, bx1 = max(ox, x0 - (x1 - x0) * pad[0]), min(ox + pw, x1 + (x1 - x0) * pad[0])
        by0, by1 = max(oy, y0 - (y1 - y0) * pad[1]), min(oy + ph, y1 + (y1 - y0) * pad[1])
        out.append([ch, (bx0 + bx1) / 2 / S, (by0 + by1) / 2 / S, (bx1 - bx0) / S, (by1 - by0) / S])
    return out


def tight_chars(m):
    """The glyph's own box (the room taken off again where meta.boxPad says there is some)."""
    if not m.get("boxPad"):
        return m["chars"]
    px, py = m["boxPad"]
    return [[ch, cx, cy, w / (1 + 2 * px), h / (1 + 2 * py)] for ch, cx, cy, w, h in m["chars"]]
