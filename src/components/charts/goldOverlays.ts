// Gold chart overlays: turn the BOT'S observations into Lightweight Charts drawings.
//
// The chart draws; the bot decides. Nothing in this file detects a pattern: every marker,
// line and zone is one observation from /api/v1/gold/observations (backend
// app/market/chart_observations.py), placed at the time and price the backend gave it.
// Each drawing keeps its observation_id, so clicking it shows the observation itself.

import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesMarker,
  Time,
} from 'lightweight-charts';

export interface Observation {
  observation_id: string;
  zone_id: string | null;
  observation_type: string;
  direction: string | null;
  label: string;
  lower_price: number | null;
  upper_price: number | null;
  start_time: number;
  end_time: number | null;
  formation_timestamp: string;
  first_available_timestamp: string;
  status: string;
  status_timestamp: string | null;
  source_timeframe: string;
  detector_id: string;
  detector_version: string;
  quality_status: string;
  detections?: number;
}

export interface SnapshotCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  closed: boolean;
}

export interface Snapshot {
  schema_version: string;
  symbol: string;
  display_symbol: string;
  source: string;
  timeframe: string;
  generated_at: string;
  data_cutoff: string | null;
  candles: SnapshotCandle[];
  observations: Observation[];
  unresolved: Record<string, string>;
  warnings: string[];
  engine_version: string;
}

/** Toggle groups. A type the backend sends but no group names is reported, never hidden. */
export const CATEGORIES: Record<string, string[]> = {
  structure: ['structure_label', 'bos', 'choch', 'inducement'],
  liquidity: ['liquidity_level', 'swept', 'run'],
  order_blocks: ['order_block'],
  fvg: ['fvg', 'ifvg'],
  bpr: ['bpr'],
  gaps: ['opening_gap'],
  candles: ['engulfing'],
  premium_discount: ['premium_discount'],
};

export const DEFAULT_ENABLED: Record<string, boolean> = {
  structure: true,
  liquidity: true,
  order_blocks: true,
  fvg: true,
  bpr: false,
  gaps: true,
  candles: false,
  premium_discount: true,
};

/** Point events become markers; everything with a price band or level is drawn as a zone. */
const MARKER_TYPES = new Set(['structure_label', 'bos', 'choch', 'inducement', 'swept', 'run', 'engulfing']);

export function categoryOf(type: string): string | null {
  for (const [cat, types] of Object.entries(CATEGORIES)) {
    if (types.includes(type)) return cat;
  }
  return null;
}

export function uncategorised(obs: Observation[]): string[] {
  return [...new Set(obs.map((o) => o.observation_type).filter((t) => categoryOf(t) === null))];
}

function visible(o: Observation, enabled: Record<string, boolean>): boolean {
  const cat = categoryOf(o.observation_type);
  return cat !== null && !!enabled[cat];
}

const BULL = '#26a69a';
const BEAR = '#ef5350';
const NEUTRAL = '#9e9e9e';

function bullish(o: Observation): boolean | null {
  if (o.direction === 'bullish' || o.direction === 'sell_side') return true;
  if (o.direction === 'bearish' || o.direction === 'buy_side') return false;
  return null;
}

export function colorOf(o: Observation): string {
  const b = bullish(o);
  return b === null ? NEUTRAL : b ? BULL : BEAR;
}

export function toMarkers(obs: Observation[], enabled: Record<string, boolean>): SeriesMarker<Time>[] {
  return obs
    .filter((o) => MARKER_TYPES.has(o.observation_type) && visible(o, enabled))
    .map((o) => {
      const up = bullish(o);
      return {
        id: o.observation_id,
        time: o.start_time as Time,
        position: up === false ? 'aboveBar' : 'belowBar',
        shape: o.observation_type === 'structure_label' ? 'circle' : up === false ? 'arrowDown' : 'arrowUp',
        color: colorOf(o),
        text: o.label,
        size: 1,
      } as SeriesMarker<Time>;
    })
    .sort((a, b) => (a.time as number) - (b.time as number));
}

export interface Zone {
  id: string;
  from: number;
  to: number;
  low: number;
  high: number;
  color: string;
  label: string;
  dashed: boolean;
}

/** Zones and levels. An open-ended zone runs to the last candle, never beyond the data. */
export function toZones(obs: Observation[], enabled: Record<string, boolean>, lastTime: number): Zone[] {
  return obs
    .filter((o) => !MARKER_TYPES.has(o.observation_type) && visible(o, enabled))
    .filter((o) => o.lower_price !== null && o.upper_price !== null)
    .map((o) => ({
      id: o.observation_id,
      from: o.start_time,
      to: o.end_time ?? lastTime,
      low: o.lower_price as number,
      high: o.upper_price as number,
      color: colorOf(o),
      label: o.label,
      // A spent zone stays visible as history but reads as spent.
      dashed: o.status !== 'active' && o.status !== 'current',
    }));
}

export function zoneAt(zones: Zone[], time: number, price: number): Zone | null {
  const hits = zones.filter((z) => time >= z.from && time <= z.to && price >= z.low && price <= z.high);
  // The narrowest band wins: a click inside an FVG that sits inside an order block means the FVG.
  return hits.sort((a, b) => a.high - a.low - (b.high - b.low))[0] ?? null;
}

// ---------------------------------------------------------------------- the zone primitive

class ZoneRenderer implements IPrimitivePaneRenderer {
  constructor(private source: ZonesPrimitive) {}

  draw(target: Parameters<IPrimitivePaneRenderer['draw']>[0]) {
    const { chart, series } = this.source;
    if (!chart || !series) return;
    const ts = chart.timeScale();
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const z of this.source.zones) {
        const x1 = ts.timeToCoordinate(z.from as Time);
        const x2 = ts.timeToCoordinate(z.to as Time);
        const y1 = series.priceToCoordinate(z.high);
        const y2 = series.priceToCoordinate(z.low);
        // Off-screen or outside the data: skip, never guess a position.
        if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
        const w = Math.max(x2 - x1, 1);
        ctx.save();
        ctx.setLineDash(z.dashed ? [4, 3] : []);
        ctx.strokeStyle = z.color;
        if (z.high === z.low) {
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x1 + w, y1);
          ctx.stroke();
        } else {
          ctx.globalAlpha = z.dashed ? 0.08 : 0.18;
          ctx.fillStyle = z.color;
          ctx.fillRect(x1, y1, w, y2 - y1);
          ctx.globalAlpha = 0.8;
          ctx.strokeRect(x1, y1, w, y2 - y1);
        }
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = z.color;
        ctx.font = '10px sans-serif';
        ctx.fillText(z.label, x1 + 2, Math.min(y1, y2) - 2);
        ctx.restore();
      }
    });
  }
}

class ZoneView implements IPrimitivePaneView {
  constructor(private source: ZonesPrimitive) {}

  renderer() {
    return new ZoneRenderer(this.source);
  }

  zOrder() {
    return 'bottom' as const;
  }
}

/** Draws zones in price/time coordinates, so pan, zoom and resize keep them aligned. */
export class ZonesPrimitive implements ISeriesPrimitive<Time> {
  zones: Zone[] = [];
  chart: IChartApi | null = null;
  series: ISeriesApi<'Candlestick'> | null = null;
  private requestUpdate: (() => void) | null = null;
  private views = [new ZoneView(this)];

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

  /** Replace, never append: a refresh redraws the same identities, it does not add copies. */
  setZones(zones: Zone[]) {
    this.zones = zones;
    this.requestUpdate?.();
  }

  paneViews() {
    return this.views;
  }
}
