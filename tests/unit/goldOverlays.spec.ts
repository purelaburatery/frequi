// Gold chart overlays: the renderer must draw exactly what the bot sent, where it said,
// and nothing else. Copied into freqUI-src/tests/unit by apply.py.
import { describe, expect, it } from 'vitest';
import {
  CATEGORIES,
  DEFAULT_ENABLED,
  ZonesPrimitive,
  categoryOf,
  inView,
  type Snapshot,
  toMarkers,
  toZones,
  uncategorised,
  zoneAt,
  type Observation,
} from '@/components/charts/goldOverlays';

function obs(over: Partial<Observation>): Observation {
  return {
    observation_id: 'x',
    zone_id: null,
    observation_type: 'fvg',
    direction: 'bullish',
    label: 'FVG',
    lower_price: 100,
    upper_price: 102,
    start_time: 1000,
    end_time: null,
    formation_timestamp: '2026-09-17T12:00:00+00:00',
    first_available_timestamp: '2026-09-17T12:30:00+00:00',
    status: 'active',
    status_timestamp: null,
    source_timeframe: '15m',
    detector_id: 'gaps.find_gaps',
    detector_version: 'market_state/1.1',
    quality_status: 'OK',
    ...over,
  };
}

const ALL_ON = Object.fromEntries(Object.keys(CATEGORIES).map((c) => [c, true]));

describe('goldOverlays', () => {
  it('draws a zone at exactly the prices and times the bot sent', () => {
    const [z] = toZones([obs({ observation_id: 'fvg:1', end_time: 4000 })], ALL_ON, 9000);
    expect(z).toMatchObject({ id: 'fvg:1', from: 1000, to: 4000, low: 100, high: 102 });
  });

  it('runs an open zone to the last candle and never beyond the data', () => {
    const [z] = toZones([obs({ end_time: null })], ALL_ON, 9000);
    expect(z.to).toBe(9000);
  });

  it('turns point events into markers carrying their observation id', () => {
    const m = toMarkers(
      [obs({ observation_id: 'bos:1', observation_type: 'bos', label: 'BOS', direction: 'bearish', start_time: 2000 })],
      ALL_ON,
    );
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ id: 'bos:1', time: 2000, text: 'BOS', position: 'aboveBar' });
  });

  it('toggles visibility without touching the observations', () => {
    const list = [obs({ observation_type: 'bpr', observation_id: 'bpr:1' })];
    const before = JSON.stringify(list);
    expect(toZones(list, { ...ALL_ON, bpr: false }, 9000)).toHaveLength(0);
    expect(toZones(list, ALL_ON, 9000)).toHaveLength(1);
    expect(JSON.stringify(list)).toBe(before);
  });

  it('marks spent zones as spent rather than hiding them', () => {
    const [z] = toZones([obs({ status: 'tapped', end_time: 3000 })], ALL_ON, 9000);
    expect(z.dashed).toBe(true);
  });

  it('reports a type it has no category for instead of dropping it silently', () => {
    expect(uncategorised([obs({ observation_type: 'mystery' })])).toEqual(['mystery']);
    expect(toZones([obs({ observation_type: 'mystery' })], ALL_ON, 9000)).toHaveLength(0);
  });

  it('finds the clicked zone, preferring the narrowest band', () => {
    const zones = toZones(
      [
        obs({ observation_id: 'ob', observation_type: 'order_block', lower_price: 99, upper_price: 105 }),
        obs({ observation_id: 'fvg', lower_price: 100, upper_price: 102 }),
      ],
      ALL_ON,
      9000,
    );
    expect(zoneAt(zones, 2000, 101)?.id).toBe('fvg');
    expect(zoneAt(zones, 2000, 104)?.id).toBe('ob');
    expect(zoneAt(zones, 2000, 200)).toBeNull();
  });

  it('replaces zones on refresh instead of appending duplicates', () => {
    const p = new ZonesPrimitive();
    const zones = toZones([obs({ observation_id: 'a' })], ALL_ON, 9000);
    p.setZones(zones);
    p.setZones(zones);
    expect(p.zones).toHaveLength(1);
  });

  it('draws only the selected ids by default, everything in history, and edits nothing', () => {
    const all = ['s1', 's2', 'z1', 'z2', 'z3', 'z4'].map((id) => obs({ observation_id: id }));
    const snap = {
      observations: all,
      display: { rules: 'chart_display/1.0', swings: ['s1'], liquidity: [], always: [],
        zones: { fvg: ['z1', 'z2', 'z3'] } },
    } as unknown as Snapshot;
    const before = JSON.stringify(all);
    expect(inView(snap, false).map((o) => o.observation_id)).toEqual(['s1', 'z1', 'z2', 'z3']);
    expect(inView(snap, true)).toHaveLength(6);
    expect(JSON.stringify(all)).toBe(before);
  });

  it('every backend kind has a category and a default', () => {
    for (const k of ['structure_label', 'bos', 'choch', 'inducement', 'liquidity_level', 'swept',
      'run', 'order_block', 'fvg', 'ifvg', 'bpr', 'opening_gap', 'engulfing', 'premium_discount']) {
      const cat = categoryOf(k);
      expect(cat).not.toBeNull();
      expect(DEFAULT_ENABLED).toHaveProperty(cat as string);
    }
  });
});
