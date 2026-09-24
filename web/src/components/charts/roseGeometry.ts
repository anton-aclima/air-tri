/**
 * Rose geometry, shared by `WindRose` and the map's `MiniRose`.
 *
 * One file so the two roses cannot disagree about which way a petal points.
 * Meteorological convention: `deg` is the direction the wind blows FROM,
 * clockwise from north, and a petal at `deg` points that way — up is north,
 * screen y grows downward.
 */

/** The point `r` from `(cx, cy)` on compass bearing `deg`, in screen space. */
export function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
}

/** A closed annular wedge from `r0` to `r1`, bearings `a0` to `a1`. */
export function petal(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r1, a0);
  const [x1, y1] = polar(cx, cy, r1, a1);
  const [x2, y2] = polar(cx, cy, r0, a1);
  const [x3, y3] = polar(cx, cy, r0, a0);
  return `M ${x0} ${y0} A ${r1} ${r1} 0 0 1 ${x1} ${y1} L ${x2} ${y2} A ${r0} ${r0} 0 0 0 ${x3} ${y3} Z`;
}

/**
 * The same wedge left OPEN at `r0`: side, outer arc, side. For an
 * outline-only rose, where sixteen inner arcs a few pixels from the centre
 * would merge into a dark knot; a hub circle at `r0` closes them instead.
 */
export function openPetal(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r0, a0);
  const [x1, y1] = polar(cx, cy, r1, a0);
  const [x2, y2] = polar(cx, cy, r1, a1);
  const [x3, y3] = polar(cx, cy, r0, a1);
  return `M ${x0} ${y0} L ${x1} ${y1} A ${r1} ${r1} 0 0 1 ${x2} ${y2} L ${x3} ${y3}`;
}
