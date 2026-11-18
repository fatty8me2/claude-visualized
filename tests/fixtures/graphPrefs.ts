import type { Page } from 'playwright';

/**
 * Finished subagents fold into their parent's "N finished" chip by default. Suites that look at a finished agent's card
 * (the fixture's a1, OpenCode's child) turn "show finished" on first, then reload so the graph reads it.
 */
export async function showFinishedAgents(page: Page) {
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(() => localStorage.setItem('cvis.graph.v1', JSON.stringify({ zoom: 'fit', compact: 'auto', showFinished: true })));
  await page.reload();
}
