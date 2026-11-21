import { afterEach, describe, expect, it, vi } from 'vitest';

const registerSW = vi.fn();
vi.mock('virtual:pwa-register', () => ({ registerSW }));

describe('startAppUpdates', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    registerSW.mockReset();
  });

  async function start({ online = true } = {}) {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    const document = { visibilityState: 'hidden', addEventListener: (type: string, listener: () => void) => listeners.set(type, listener) };
    vi.stubGlobal('document', document);
    vi.stubGlobal('navigator', { onLine: online });
    const { startAppUpdates } = await import('./app-updates');
    startAppUpdates();
    const options = registerSW.mock.calls[0]![0] as { immediate: boolean; onRegisteredSW: (url: string, registration: unknown) => void };
    const registration = { update: vi.fn().mockResolvedValue(undefined) };
    options.onRegisteredSW('sw.js', registration);
    return { options, registration, document, listeners };
  }

  it("registers the service worker straight away, keeping the plugin's reload once an update takes over", async () => {
    const { options } = await start();
    expect(options.immediate).toBe(true);
    // No onNeedReload: vite-plugin-pwa's autoUpdate mode then reloads the page itself.
    expect(options).not.toHaveProperty('onNeedReload');
  });

  it('checks for a new version when the app comes back to the foreground, and hourly', async () => {
    const { registration, document, listeners } = await start();
    document.visibilityState = 'visible';
    listeners.get('visibilitychange')!();
    expect(registration.update).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(registration.update).toHaveBeenCalledTimes(2);
  });

  it('does not check while offline', async () => {
    const { registration, document, listeners } = await start({ online: false });
    document.visibilityState = 'visible';
    listeners.get('visibilitychange')!();
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(registration.update).not.toHaveBeenCalled();
  });
});
