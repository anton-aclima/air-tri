/**
 * Label collision — a monitor's name and a site's name hide each other
 * instead of overprinting (PLAN-refocus R3).
 *
 * Riverport Road's monitor stands 425 m from Riverport Intermodal Terminal's
 * centroid (Harbor Avenue is 1,081 m from Delta Forge's). At the default view,
 * zoom 12.6, 425 m is about 41 px, and the two names — 84 and 191 px wide in
 * caps, more once a reading is appended — print across each other. That is
 * the owner's "text starts running into each other" on the map itself.
 *
 * Why not deck.gl's `CollisionFilterExtension` (installed, 9.3): read its
 * shader and it cannot do this job.
 *   1. It tests each label at its ANCHOR (`geometry.worldPosition`) and hides
 *      it only if another label's glyphs cover that point. Both labels here
 *      are pixel-offset from their anchors (a monitor's name hangs 12 px under
 *      its mast, a site's 14 px under its centroid), so two names can overlap
 *      completely while neither anchor is covered.
 *   2. It compares picking colours in RGB only, and deck encodes a picking
 *      colour as the object's index WITHIN its layer (`encodePickingColor`,
 *      the layer index goes in alpha). Monitor #0 and site #0 therefore share
 *      a colour and read as "the same object" — the one cross-layer pair that
 *      most needs to collide never does.
 * So the pass is a small greedy placement on the CPU, run against deck's own
 * viewport: the real projection, bearing and pitch included, and the caller
 * never has to thread the zoom through.
 *
 * Usage — one collider per layer build, handed to every layer that takes part:
 *
 *   const collision = labelCollision();
 *   layers = [
 *     ...SiteLayer({ …, collision }),
 *     ...MonitorLayer({ …, collision }),   // order does not matter
 *   ];
 *
 * Priority, not call order, decides who wins: every monitor outranks every
 * site, and a monitor's mast is an obstacle too, so a site name never prints
 * across an instrument. Placement is resolved lazily, when deck first draws,
 * by which time every layer has registered its labels.
 */

import { CompositeLayer } from 'deck.gl';
import type { UpdateParameters, Viewport } from 'deck.gl';
import { TextLayer } from '@deck.gl/layers';
import type { TextLayerProps } from '@deck.gl/layers';

/** One box that takes part in placement. */
export interface LabelCandidate {
  /** Unique within the collider. A layer shows a label only if its key is placed. */
  key: string;
  /** Boxes with the same owner never hide each other (a mast and its own name). */
  owner: string;
  position: readonly [number, number];
  /** Pixel box relative to the projected anchor, y down: [left, top, right, bottom]. */
  box: readonly [number, number, number, number];
  /** Higher wins. See `LABEL_PRIORITY`. */
  priority: number;
  /** An obstacle: blocks lower-priority labels, is never hidden itself. */
  fixed?: boolean;
}

/**
 * The ranking. The gaps are wide so a per-item boost (selected, hovered,
 * over a level) can never lift a site over a monitor: "monitors win" is a
 * rule of the map, not a tie-break.
 */
export const LABEL_PRIORITY = {
  monitor: 3000,
  sensor: 2000,
  site: 1000,
  /** Added for the thing the reader is looking at. Stays under the tier gap. */
  selected: 400,
  hovered: 300,
  over: 200,
} as const;

/**
 * Monospace advance: JetBrains Mono (the labels' `--font-mono`) is 600/1000
 * em, and the uppercase labels never contain a proportional glyph.
 */
const MONO_EM = 0.6;

/**
 * A text label's pixel box relative to its anchor, for the TextLayer settings
 * the map layers use. `+1` each side is the SDF outline (outlineWidth 3 at
 * these sizes spills about a pixel past the glyph).
 */
export function textBox(
  text: string,
  sizePx: number,
  anchor: 'start' | 'middle' | 'end',
  baseline: 'top' | 'center' | 'bottom',
  offset: readonly [number, number] = [0, 0],
): [number, number, number, number] {
  const w = [...text].length * sizePx * MONO_EM + 2;
  const h = sizePx + 2;
  const x0 = anchor === 'start' ? -1 : anchor === 'end' ? -w + 1 : -w / 2;
  const y0 = baseline === 'top' ? -1 : baseline === 'bottom' ? -h + 1 : -h / 2;
  return [x0 + offset[0], y0 + offset[1], x0 + w + offset[0], y0 + h + offset[1]];
}

type Rect = { owner: string; x0: number; y0: number; x1: number; y1: number };

const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

export class LabelCollision {
  /** Clearance kept around every box, px. */
  readonly padPx: number;
  private readonly groups = new Map<string, readonly LabelCandidate[]>();
  private version = 0;
  private cache: { sig: string; shown: ReadonlySet<string> } | null = null;

  constructor(padPx = 1.5) {
    this.padPx = padPx;
  }

  /**
   * Register (or replace) one layer's boxes. Keyed by `group`, so a collider
   * the caller memoises across renders does not accumulate stale labels.
   */
  register(group: string, items: readonly LabelCandidate[]): void {
    this.groups.set(group, items);
    this.version += 1;
    this.cache = null;
  }

  /** The keys that are placed in this viewport. Cached per viewport. */
  shown(viewport: Viewport): ReadonlySet<string> {
    const v = viewport as Viewport & {
      longitude?: number; latitude?: number; bearing?: number; pitch?: number;
    };
    const sig = [
      this.version, v.width, v.height, v.zoom,
      v.longitude ?? 0, v.latitude ?? 0, v.bearing ?? 0, v.pitch ?? 0,
    ].join('|');
    if (this.cache?.sig === sig) return this.cache.shown;

    const all = [...this.groups.values()].flat().sort((a, b) => (b.priority - a.priority)
      // At equal priority an obstacle goes first: a mast is never "behind" a label.
      || Number(Boolean(b.fixed)) - Number(Boolean(a.fixed))
      || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    const pad = this.padPx;
    const placed: Rect[] = [];
    const shown = new Set<string>();
    for (const c of all) {
      const p = viewport.project([c.position[0], c.position[1]]);
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      const r: Rect = {
        owner: c.owner,
        x0: p[0] + c.box[0] - pad, y0: p[1] + c.box[1] - pad,
        x1: p[0] + c.box[2] + pad, y1: p[1] + c.box[3] + pad,
      };
      if (!c.fixed && placed.some((q) => q.owner !== c.owner && overlaps(q, r))) continue;
      placed.push(r);
      if (!c.fixed) shown.add(c.key);
    }
    this.cache = { sig, shown };
    return shown;
  }
}

/** A fresh collider. Create one per layer build and pass it to each layer. */
export function labelCollision(opts: { padPx?: number } = {}): LabelCollision {
  return new LabelCollision(opts.padPx);
}

// ───────────────────────────────────────────── the layer that obeys it

type AnyTextProps<D> = Omit<TextLayerProps<D>, 'id' | 'data'>;

interface CollidingTextProps<D> {
  items: readonly D[];
  keyOf: (d: D) => string;
  collision: LabelCollision;
  /** Every TextLayer prop except `id` and `data`. */
  text: AnyTextProps<D>;
}

/**
 * A TextLayer that draws only the items the collider placed.
 *
 * It re-asks on every viewport change (`shouldUpdateState` → somethingChanged,
 * the pattern deck's own clustering examples use), so zooming in brings a
 * hidden name back as soon as there is room for it. Only the placement is
 * recomputed; the TextLayer's data changes only when the placed set does.
 */
class CollidingTextLayer<D> extends CompositeLayer<CollidingTextProps<D>> {
  static layerName = 'CollidingTextLayer';

  declare state: { shown: D[]; sig: string };

  shouldUpdateState({ changeFlags }: UpdateParameters<this>): boolean {
    return Boolean(changeFlags.somethingChanged);
  }

  updateState({ props, changeFlags }: UpdateParameters<this>): void {
    const placed = props.collision.shown(this.context.viewport);
    const shown = props.items.filter((d) => placed.has(props.keyOf(d)));
    const sig = shown.map(props.keyOf).join('\u0000');
    if (changeFlags.propsOrDataChanged || sig !== this.state?.sig) this.setState({ shown, sig });
  }

  renderLayers() {
    const { text } = this.props;
    return new TextLayer<D>({
      ...text,
      ...this.getSubLayerProps({ id: 'text', updateTriggers: text.updateTriggers }),
      data: this.state.shown,
    });
  }
}

/**
 * Build a label layer that takes part in `collision` — or, with no collider,
 * the plain TextLayer the map layers always drew, so every existing caller is
 * byte-for-byte unchanged.
 */
export function collidingText<D>(opts: {
  id: string;
  items: readonly D[];
  keyOf: (d: D) => string;
  collision?: LabelCollision | null;
  visible?: boolean;
  pickable?: boolean;
  onHover?: TextLayerProps<D>['onHover'];
  onClick?: TextLayerProps<D>['onClick'];
  text: AnyTextProps<D>;
}) {
  const { id, items, keyOf, collision, visible = true, pickable = false, onHover, onClick, text } = opts;
  const handlers = { ...(onHover ? { onHover } : {}), ...(onClick ? { onClick } : {}) };
  if (!collision) {
    return new TextLayer<D>({ ...text, id, data: items as D[], visible, pickable, ...handlers });
  }
  // deck dispatches pointer events to the ROOT layer's handler, which is the
  // wrapper here, not the TextLayer inside it.
  return new CollidingTextLayer<D>({ id, items, keyOf, collision, text, visible, pickable, ...handlers });
}
