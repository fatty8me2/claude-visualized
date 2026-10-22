// Which sections an overview panel shows, by size and density; the columns-from-width rule for the agent graph.
import { describe, expect, it } from 'vitest';
import { coarseNow, compactForecast, ctxTone, panelPlan, panelTier, TIER_HYSTERESIS, TIER_LIMITS } from '@core/panelContent';
import { columnsForWidth } from '@core/graphZoom';

describe('panelTier', () => {
  it('grows small -> medium -> large with the body height', () => {
    expect(panelTier(800, 300, 'comfortable')).toBe('small');
    expect(panelTier(800, 450, 'comfortable')).toBe('medium');
    expect(panelTier(800, 760, 'comfortable')).toBe('large');
    expect(panelTier(1500, 880, 'comfortable')).toBe('large');
  });
  it('needs width for the large tier', () => {
    expect(panelTier(380, 900, 'comfortable')).toBe('medium');
  });
  it('compact density never leaves the small tier', () => {
    expect(panelTier(1800, 1000, 'compact')).toBe('small');
  });
  it('spacious density shows more sooner than comfortable', () => {
    expect(panelTier(800, 360, 'spacious')).toBe('medium');
    expect(panelTier(800, 360, 'comfortable')).toBe('small');
    expect(panelTier(800, 640, 'spacious')).toBe('large');
    expect(panelTier(800, 640, 'comfortable')).toBe('medium');
  });
  it('is sticky near a limit, so a drag does not flicker', () => {
    const lim = TIER_LIMITS.comfortable.medium;
    expect(panelTier(800, lim - 5, 'comfortable')).toBe('small');
    expect(panelTier(800, lim - 5, 'comfortable', 'medium')).toBe('medium');
    expect(panelTier(800, lim - TIER_HYSTERESIS - 1, 'comfortable', 'medium')).toBe('small');
    const big = TIER_LIMITS.comfortable.large;
    expect(panelTier(800, big - 5, 'comfortable', 'large')).toBe('large');
    expect(panelTier(800, big - 5, 'comfortable', 'medium')).toBe('medium');
  });
  it('keeps the previous tier while the body is not measured yet', () => {
    expect(panelTier(0, 0, 'comfortable')).toBe('small');
    expect(panelTier(0, 0, 'comfortable', 'large')).toBe('large');
  });
});

describe('panelPlan', () => {
  it('small: graph and a 2-line log only', () => {
    const p = panelPlan('small', 'comfortable', 800, 300, true);
    expect(p).toMatchObject({ rail: false, feed: false, plan: false, table: false, logLines: 2 });
  });
  it('medium adds the rail and keeps the log', () => {
    const p = panelPlan('medium', 'comfortable', 800, 500, true);
    expect(p).toMatchObject({ rail: true, feed: false, plan: false, table: false, logLines: 2 });
  });
  it('large adds feed and table, and the plan strip only with a plan', () => {
    const w = panelPlan('large', 'comfortable', 900, 800, true);
    expect(w).toMatchObject({ rail: true, feed: true, plan: true, table: true, wide: true, logLines: 0 });
    expect(w.tableRows).toBeGreaterThanOrEqual(3);
    expect(panelPlan('large', 'comfortable', 900, 800, false).plan).toBe(false);
  });
  it('a stacked large panel drops the table unless it is tall', () => {
    expect(panelPlan('large', 'comfortable', 600, 740, false)).toMatchObject({ wide: false, table: false, feed: true });
    expect(panelPlan('large', 'comfortable', 600, 800, false)).toMatchObject({ wide: false, table: true });
  });
  it('spacious shows a longer log', () => {
    expect(panelPlan('small', 'spacious', 800, 300, false).logLines).toBe(4);
  });
  it('more table rows in a taller panel, within bounds', () => {
    const a = panelPlan('large', 'comfortable', 900, 600, false).tableRows;
    const b = panelPlan('large', 'comfortable', 900, 1400, false).tableRows;
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThanOrEqual(16);
    expect(panelPlan('large', 'comfortable', 700, 1400, false).tableRows).toBeLessThanOrEqual(5);
  });
});

describe('insight formatting', () => {
  it('warns under 15 minutes to auto-compact', () => {
    expect(compactForecast(41)).toEqual({ text: 'auto-compact in ~41 min', tone: 'ok' });
    expect(compactForecast(14.6).tone).toBe('warn');
    expect(compactForecast(2).text).toBe('auto-compact in ~2 min');
    expect(compactForecast(0.2)).toEqual({ text: 'auto-compact imminent', tone: 'warn' });
    expect(compactForecast(180).text).toBe('auto-compact in ~3 h');
    expect(compactForecast(null).tone).toBe('none');
  });
  it('context tone', () => {
    expect([null, 10, 70, 90].map(ctxTone)).toEqual(['none', 'ok', 'warn', 'hot']);
  });
  it('quantizes the clock', () => {
    expect(coarseNow(14_999)).toBe(0);
    expect(coarseNow(15_000)).toBe(15_000);
    expect(coarseNow(44_000)).toBe(30_000);
  });
});

describe('columnsForWidth', () => {
  it('follows the width, within bounds', () => {
    expect(columnsForWidth(800, 196, 20, 14)).toBe(3);
    expect(columnsForWidth(1500, 240, 22, 36)).toBe(5);
    expect(columnsForWidth(100, 240, 22, 36)).toBe(2);
    expect(columnsForWidth(9000, 196, 20, 14)).toBe(12);
    expect(columnsForWidth(0, 196, 20, 14)).toBe(12);
  });
});
