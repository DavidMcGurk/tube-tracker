import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectInstallPlatform,
  DISMISSAL_PERIOD_MS,
  getInstallPromptVariant,
  isStandalone,
  sanitizeInstallPromptState,
  type InstallPlatform
} from './install-prompt';

const USER_AGENTS = {
  iPhoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  iPhoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1',
  iPhoneFirefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/141.0 Mobile/15E148 Safari/605.1.15',
  iPhoneInstagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 390.0.0.0',
  iPadLegacy: 'Mozilla/5.0 (iPad; CPU OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  androidChrome: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 15; Mobile; rv:141.0) Gecko/141.0 Firefox/141.0',
  desktopChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
};

describe('isStandalone', () => {
  it('is true for any standalone signal and false otherwise', () => {
    const none = { displayModeStandalone: false, displayModeFullscreen: false, navigatorStandalone: false };
    expect(isStandalone(none)).toBe(false);
    expect(isStandalone({ ...none, displayModeStandalone: true })).toBe(true);
    expect(isStandalone({ ...none, displayModeFullscreen: true })).toBe(true);
    expect(isStandalone({ ...none, navigatorStandalone: true })).toBe(true);
  });
});

describe('detectInstallPlatform', () => {
  it.each<[keyof typeof USER_AGENTS, number, InstallPlatform]>([
    ['iPhoneSafari', 5, 'ios-safari'],
    ['iPhoneChrome', 5, 'ios-other-browser'],
    ['iPhoneFirefox', 5, 'ios-other-browser'],
    ['iPhoneInstagram', 5, 'ios-other-browser'],
    ['iPadLegacy', 5, 'ipados'],
    // iPadOS Safari requests desktop sites with a Macintosh user agent; touch support tells it apart from a Mac.
    ['macSafari', 5, 'ipados'],
    ['macSafari', 0, 'other'],
    ['androidChrome', 5, 'android'],
    ['androidFirefox', 5, 'android'],
    ['desktopChrome', 0, 'other'],
    ['desktopChrome', 10, 'other']
  ])('%s with %i touch points is %s', (agent, maxTouchPoints, expected) => {
    expect(detectInstallPlatform({ userAgent: USER_AGENTS[agent], maxTouchPoints })).toBe(expected);
  });

  it('treats a Mac with a single emulated touch point as a desktop', () => {
    expect(detectInstallPlatform({ userAgent: USER_AGENTS.macSafari, maxTouchPoints: 1 })).toBe('other');
  });
});

describe('getInstallPromptVariant', () => {
  const now = Date.UTC(2026, 10, 21);
  const base = {
    platform: 'ios-safari' as InstallPlatform,
    hasDeferredPrompt: false,
    isMobile: true,
    standalone: false,
    dismissedAt: undefined,
    installed: false,
    now
  };

  it('offers Share instructions on iOS and the native prompt where one was captured', () => {
    expect(getInstallPromptVariant(base)).toBe('ios-share');
    expect(getInstallPromptVariant({ ...base, platform: 'ios-other-browser' })).toBe('ios-share');
    expect(getInstallPromptVariant({ ...base, platform: 'ipados' })).toBe('ipad-share');
    expect(getInstallPromptVariant({ ...base, platform: 'android', hasDeferredPrompt: true })).toBe('native');
    expect(getInstallPromptVariant({ ...base, platform: 'other', hasDeferredPrompt: true })).toBe('native');
  });

  it('offers nothing where the browser cannot install and gave no prompt', () => {
    expect(getInstallPromptVariant({ ...base, platform: 'android' })).toBeNull();
    expect(getInstallPromptVariant({ ...base, platform: 'other' })).toBeNull();
  });

  it('never shows inside the installed app, after an install, or on desktop', () => {
    expect(getInstallPromptVariant({ ...base, standalone: true })).toBeNull();
    expect(getInstallPromptVariant({ ...base, installed: true })).toBeNull();
    expect(getInstallPromptVariant({ ...base, isMobile: false })).toBeNull();
    expect(getInstallPromptVariant({ ...base, platform: 'android', hasDeferredPrompt: true, isMobile: false })).toBeNull();
  });

  it('stays hidden for 30 days after a dismissal', () => {
    const day = 24 * 60 * 60 * 1000;
    expect(getInstallPromptVariant({ ...base, dismissedAt: now })).toBeNull();
    expect(getInstallPromptVariant({ ...base, dismissedAt: now - 3 * day })).toBeNull();
    expect(getInstallPromptVariant({ ...base, dismissedAt: now - DISMISSAL_PERIOD_MS + 1 })).toBeNull();
    expect(getInstallPromptVariant({ ...base, dismissedAt: now - DISMISSAL_PERIOD_MS })).toBe('ios-share');
    expect(getInstallPromptVariant({ ...base, dismissedAt: now - 40 * day })).toBe('ios-share');
  });
});

describe('sanitizeInstallPromptState', () => {
  it('keeps finite timestamps and drops anything else', () => {
    expect(sanitizeInstallPromptState({ dismissedAt: 5, installedAt: 7 })).toEqual({ dismissedAt: 5, installedAt: 7 });
    expect(sanitizeInstallPromptState({ dismissedAt: '5', installedAt: Number.NaN, extra: true })).toEqual({});
    expect(sanitizeInstallPromptState(null)).toEqual({});
    expect(sanitizeInstallPromptState('dismissed')).toEqual({});
  });
});

describe('install event capture', () => {
  type CaptureModule = typeof import('./install-prompt');
  let capture: CaptureModule;
  let target: EventTarget;

  function installEvent(outcome: 'accepted' | 'dismissed' = 'accepted') {
    const prompt = vi.fn(() => Promise.resolve());
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      platforms: ['web'],
      prompt,
      userChoice: Promise.resolve({ outcome, platform: 'web' })
    });
    return { event, prompt };
  }

  beforeEach(async () => {
    vi.resetModules();
    capture = await import('./install-prompt');
    target = new EventTarget();
    capture.initInstallPromptCapture(target as unknown as Window);
  });

  it('stores the install event, suppresses the browser UI and notifies subscribers', () => {
    const listener = vi.fn();
    capture.subscribeInstallCapture(listener);
    const { event } = installEvent();
    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(capture.getInstallCaptureSnapshot()).toEqual({ deferredPrompt: event, installed: false });
  });

  it('hands the event out only once', () => {
    const { event } = installEvent();
    target.dispatchEvent(event);
    const before = capture.getInstallCaptureSnapshot();

    expect(capture.takeDeferredInstallPrompt()).toBe(event);
    expect(capture.takeDeferredInstallPrompt()).toBeNull();
    expect(capture.getInstallCaptureSnapshot()).not.toBe(before);
    expect(capture.getInstallCaptureSnapshot().deferredPrompt).toBeNull();
  });

  it('records an install and drops the spent event', () => {
    target.dispatchEvent(installEvent().event);
    target.dispatchEvent(new Event('appinstalled'));
    expect(capture.getInstallCaptureSnapshot()).toEqual({ deferredPrompt: null, installed: true });
  });

  it('keeps a stable snapshot between changes and stops notifying after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = capture.subscribeInstallCapture(listener);
    expect(capture.getInstallCaptureSnapshot()).toBe(capture.getInstallCaptureSnapshot());
    unsubscribe();
    target.dispatchEvent(installEvent().event);
    expect(listener).not.toHaveBeenCalled();
  });

  it('only attaches its listeners once', () => {
    const listener = vi.fn();
    capture.subscribeInstallCapture(listener);
    capture.initInstallPromptCapture(target as unknown as Window);
    target.dispatchEvent(installEvent().event);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
