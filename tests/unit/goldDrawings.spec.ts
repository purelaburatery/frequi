// The owner's own drawing tools. Copied into freqUI-src/tests/unit by apply.py.
import { describe, expect, it } from 'vitest';
import {
  DrawingsPrimitive,
  TOOLS,
  loadDrawings,
  measureLabel,
  needsTwoPoints,
  saveDrawings,
  snap,
  storageKey,
} from '@/components/charts/goldDrawings';

describe('goldDrawings', () => {
  it('magnet snaps to the nearest of open, high, low, close', () => {
    const bar = { time: 1, open: 100, high: 105, low: 95, close: 102 };
    expect(snap(104.2, bar)).toBe(105);
    expect(snap(101.4, bar)).toBe(102);
    expect(snap(96, bar)).toBe(95);
    expect(snap(96, undefined)).toBe(96);           // no bar: the click price stands
  });

  it('measure reads price change, percent and bars', () => {
    expect(measureLabel({ time: 0, price: 100 }, { time: 900 * 8, price: 103 }, 900)).toBe(
      '+3.00 (+3.00%) · 8 bars',
    );
    expect(measureLabel({ time: 0, price: 200 }, { time: 300, price: 190 }, 300)).toBe(
      '-10.00 (-5.00%) · 1 bars',
    );
  });

  it('two clicks for trend, rectangle and measure; one for the rest', () => {
    expect(['trend', 'rect', 'measure'].every((t) => needsTwoPoints(t as never))).toBe(true);
    expect(['cursor', 'hline', 'text'].some((t) => needsTwoPoints(t as never))).toBe(false);
    expect(TOOLS.map((t) => t.id)).toContain('cursor');
  });

  it('drawings round-trip per symbol and timeframe, and a corrupt store reads as empty', () => {
    const key = storageKey('XAUUSD+', '15m');
    expect(key).toBe('gold-drawings:XAUUSD+:15m');
    const list = [{ id: 'a', tool: 'hline' as const, p1: { time: 1, price: 100 } }];
    saveDrawings(key, list);
    expect(loadDrawings(key)).toEqual(list);
    localStorage.setItem(key, '{not json');
    expect(loadDrawings(key)).toEqual([]);
    expect(loadDrawings(storageKey('XAUUSD+', '1h'))).toEqual([]);   // other timeframe is separate
  });

  it('the primitive replaces its drawings rather than appending', () => {
    const p = new DrawingsPrimitive();
    const list = [{ id: 'a', tool: 'hline' as const, p1: { time: 1, price: 100 } }];
    p.update({ drawings: list });
    p.update({ drawings: list });
    expect(p.drawings).toHaveLength(1);
    p.update({ hidden: true });
    expect(p.hidden).toBe(true);
  });
});
