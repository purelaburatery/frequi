// The owner's own chart drawings - trend lines, horizontal lines, rectangles, text, measure.
//
// SEPARATE FROM THE BOT. These are the person's marks on the chart, kept in this browser only
// (localStorage, per symbol and timeframe). They never reach the backend, never become an
// observation and never feed analysis or a decision. The bot's observations are drawn by
// goldOverlays.ts and cannot be edited from here.

import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from 'lightweight-charts';

export type Tool = 'cursor' | 'trend' | 'hline' | 'rect' | 'text' | 'measure';
export type DrawTool = Exclude<Tool, 'cursor'>;

export const TOOLS: { id: Tool; icon: string; label: string }[] = [
  { id: 'cursor', icon: 'i-mdi-cursor-default', label: 'Cursor / inspect' },
  { id: 'trend', icon: 'i-mdi-vector-line', label: 'Trend line' },
  { id: 'hline', icon: 'i-mdi-minus', label: 'Horizontal line' },
  { id: 'rect', icon: 'i-mdi-rectangle-outline', label: 'Rectangle' },
  { id: 'text', icon: 'i-mdi-format-text', label: 'Text' },
  { id: 'measure', icon: 'i-mdi-ruler', label: 'Measure' },
];

export interface Point {
  time: number;
  price: number;
}

export interface Drawing {
  id: string;
  tool: DrawTool;
  p1: Point;
  p2?: Point;
  text?: string;
}

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Two clicks for these; one for the rest. */
export function needsTwoPoints(tool: Tool): boolean {
  return tool === 'trend' || tool === 'rect' || tool === 'measure';
}

/** Magnet: the bar's open, high, low or close nearest to where the click landed. */
export function snap(price: number, bar: Bar | undefined): number {
  if (!bar) return price;
  return [bar.open, bar.high, bar.low, bar.close].reduce((best, p) =>
    Math.abs(p - price) < Math.abs(best - price) ? p : best,
  );
}

/** "+12.34 (+0.29%) · 8 bars" - the measure tool's readout. */
export function measureLabel(p1: Point, p2: Point, barSeconds: number): string {
  const d = p2.price - p1.price;
  const pct = (d / p1.price) * 100;
  const bars = barSeconds > 0 ? Math.round(Math.abs(p2.time - p1.time) / barSeconds) : 0;
  const sign = d >= 0 ? '+' : '';
  return `${sign}${d.toFixed(2)} (${sign}${pct.toFixed(2)}%) · ${bars} bars`;
}

export function storageKey(symbol: string, timeframe: string): string {
  return `gold-drawings:${symbol}:${timeframe}`;
}

/** Per-viewer convenience: an unavailable or corrupt store reads as "no drawings". */
export function loadDrawings(key: string): Drawing[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveDrawings(key: string, drawings: Drawing[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(drawings));
  } catch {
    // Private window or blocked storage: drawings live for this page only.
  }
}

// ---------------------------------------------------------------------- the primitive

const INK = '#2962ff';

class DrawingRenderer implements IPrimitivePaneRenderer {
  constructor(private source: DrawingsPrimitive) {}

  draw(target: Parameters<IPrimitivePaneRenderer['draw']>[0]) {
    const { chart, series } = this.source;
    if (!chart || !series || this.source.hidden) return;
    const ts = chart.timeScale();
    const x = (p: Point) => ts.timeToCoordinate(p.time as Time);
    const y = (p: Point) => series.priceToCoordinate(p.price);
    const all = this.source.preview ? [...this.source.drawings, this.source.preview] : this.source.drawings;

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      for (const d of all) {
        const x1 = x(d.p1);
        const y1 = y(d.p1);
        if (y1 === null) continue;
        ctx.save();
        ctx.strokeStyle = INK;
        ctx.fillStyle = INK;
        ctx.lineWidth = 1.5;
        ctx.font = '11px sans-serif';
        if (d.tool === 'hline') {
          ctx.beginPath();
          ctx.moveTo(0, y1);
          ctx.lineTo(mediaSize.width, y1);
          ctx.stroke();
          ctx.fillText(d.p1.price.toFixed(2), 4, y1 - 3);
        } else if (d.tool === 'text') {
          if (x1 !== null) ctx.fillText(d.text ?? '', x1, y1);
        } else if (d.p2 && x1 !== null) {
          const x2 = x(d.p2);
          const y2 = y(d.p2);
          if (x2 === null || y2 === null) {
            ctx.restore();
            continue;
          }
          if (d.tool === 'trend') {
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
          } else {
            ctx.globalAlpha = 0.12;
            ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
            ctx.globalAlpha = 1;
            ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
            if (d.tool === 'measure') {
              ctx.fillText(measureLabel(d.p1, d.p2, this.source.barSeconds), Math.min(x1, x2) + 4, Math.min(y1, y2) - 4);
            }
          }
        }
        ctx.restore();
      }
    });
  }
}

class DrawingView implements IPrimitivePaneView {
  constructor(private source: DrawingsPrimitive) {}

  renderer() {
    return new DrawingRenderer(this.source);
  }

  zOrder() {
    return 'top' as const;
  }
}

/** Draws in price/time coordinates, so pan, zoom and resize keep every mark in place. */
export class DrawingsPrimitive implements ISeriesPrimitive<Time> {
  drawings: Drawing[] = [];
  preview: Drawing | null = null;
  hidden = false;
  barSeconds = 0;
  chart: IChartApi | null = null;
  series: ISeriesApi<'Candlestick'> | null = null;
  private requestUpdate: (() => void) | null = null;
  private views = [new DrawingView(this)];

  attached(param: SeriesAttachedParameter<Time>) {
    this.chart = param.chart as IChartApi;
    this.series = param.series as ISeriesApi<'Candlestick'>;
    this.requestUpdate = param.requestUpdate;
  }

  detached() {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  update(patch: Partial<Pick<DrawingsPrimitive, 'drawings' | 'preview' | 'hidden' | 'barSeconds'>>) {
    Object.assign(this, patch);
    this.requestUpdate?.();
  }

  paneViews() {
    return this.views;
  }
}
