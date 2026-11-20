// The discovered-server path of the local-model monitor: servers other local apps run for us (Kiln's
// worker) are added to the polled set, never duplicated against an enabled configured target, and an
// unchanged list does not re-emit the view.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { DEFAULT_LOCAL_CONFIG } from '@core/localModels';
import { LocalMonitor, type DiscoveredServer } from '../../src/main/localMonitor';

const kiln: DiscoveredServer = { id: 'kiln-openai', name: 'Kiln worker', url: 'http://127.0.0.1:8000' };

describe('LocalMonitor discovered servers', () => {
  let monitor: LocalMonitor;
  let views = 0;

  beforeEach(() => {
    monitor = new LocalMonitor(DEFAULT_LOCAL_CONFIG); // never started: nothing is polled
    monitor.on('view', () => views++);
  });

  afterEach(() => monitor.removeAllListeners());

  it('adds a discovered server to the view', () => {
    monitor.setDiscovered([kiln]);
    const ids = monitor.view().servers.map((s) => s.id);
    expect(ids).toContain('kiln-openai');
  });

  it('does not re-emit the view for an unchanged list', () => {
    monitor.setDiscovered([kiln]);
    views = 0;
    monitor.setDiscovered([{ id: 'kiln-openai', name: 'Renamed', url: 'http://127.0.0.1:8000' }]);
    expect(views).toBe(0);
  });

  it('skips a discovered server that duplicates an enabled configured target', () => {
    monitor.setDiscovered([{ id: 'kiln-ollama', name: 'Kiln worker (Ollama)', url: 'http://127.0.0.1:11434' }]);
    const servers = monitor.view().servers;
    expect(servers.filter((s) => s.id === 'kiln-ollama')).toHaveLength(0);
    // the configured Ollama target is untouched
    expect(servers.filter((s) => s.id === 'ollama')).toHaveLength(1);
  });
});
