/** Chromium's install event: fired when the app is installable; prompt() may be called once. */
export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: readonly string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

declare global {
  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
    appinstalled: Event;
  }

  interface Navigator {
    /** iOS Safari only: true when the page was launched from the home screen. */
    readonly standalone?: boolean;
  }
}

export type InstallPlatform = 'ios-safari' | 'ios-other-browser' | 'ipados' | 'android' | 'other';
export type InstallPromptVariant = 'ios-share' | 'ipad-share' | 'native';

/** Persisted: when the pop-up was dismissed, and when the browser reported an install. */
export interface InstallPromptState {
  dismissedAt?: number;
  installedAt?: number;
}

export const DISMISSAL_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

function readTimestamp(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Keeps only well-formed timestamps from a stored (and therefore untrusted) record. */
export function sanitizeInstallPromptState(value: unknown): InstallPromptState {
  if (typeof value !== 'object' || value === null) return {};
  const record = value as { dismissedAt?: unknown; installedAt?: unknown };
  const state: InstallPromptState = {};
  const dismissedAt = readTimestamp(record.dismissedAt);
  const installedAt = readTimestamp(record.installedAt);
  if (dismissedAt !== undefined) state.dismissedAt = dismissedAt;
  if (installedAt !== undefined) state.installedAt = installedAt;
  return state;
}

export function isStandalone({ displayModeStandalone, displayModeFullscreen, navigatorStandalone }: {
  displayModeStandalone: boolean;
  displayModeFullscreen: boolean;
  navigatorStandalone: boolean;
}) {
  return displayModeStandalone || displayModeFullscreen || navigatorStandalone;
}

/** Chrome, Firefox, Edge, Opera and in-app browsers on iOS. Their Share button is not where Safari's is. */
const IOS_OTHER_BROWSER_PATTERN = /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|YaBrowser|DuckDuckGo|GSA\/|FBAN|FBAV|Instagram|Line\//;

export function detectInstallPlatform({ userAgent, maxTouchPoints }: { userAgent: string; maxTouchPoints: number }): InstallPlatform {
  // iPadOS Safari reports a desktop Macintosh user agent; only the touch support gives it away.
  const isIPad = /iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  const isIPhone = /iPhone|iPod/.test(userAgent);
  if (isIPad || isIPhone) {
    if (IOS_OTHER_BROWSER_PATTERN.test(userAgent)) return 'ios-other-browser';
    return isIPad ? 'ipados' : 'ios-safari';
  }
  if (/Android/.test(userAgent)) return 'android';
  return 'other';
}

export function isDismissalActive(dismissedAt: number | undefined, now: number) {
  return dismissedAt !== undefined && now - dismissedAt < DISMISSAL_PERIOD_MS;
}

/** Which install pop-up (if any) to offer. iOS has no install API, so it gets instructions instead of a button. */
export function getInstallPromptVariant({ platform, hasDeferredPrompt, isMobile, standalone, dismissedAt, installed, now }: {
  platform: InstallPlatform;
  hasDeferredPrompt: boolean;
  isMobile: boolean;
  standalone: boolean;
  dismissedAt: number | undefined;
  installed: boolean;
  now: number;
}): InstallPromptVariant | null {
  if (standalone || installed || !isMobile || isDismissalActive(dismissedAt, now)) return null;
  if (platform === 'ios-safari' || platform === 'ios-other-browser') return 'ios-share';
  if (platform === 'ipados') return 'ipad-share';
  return hasDeferredPrompt ? 'native' : null;
}

/* ---------------------------------------------------------------- Event capture */

export interface InstallCaptureSnapshot {
  /** The captured install event, until it is used (it can only prompt once). */
  deferredPrompt: BeforeInstallPromptEvent | null;
  /** The browser reported an install during this page session. */
  installed: boolean;
}

let snapshot: InstallCaptureSnapshot = { deferredPrompt: null, installed: false };
const listeners = new Set<() => void>();
let captureTarget: Window | null = null;

function updateSnapshot(next: Partial<InstallCaptureSnapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => listener());
}

/**
 * Starts listening for the browser's install events. Call it before rendering: Chromium can fire
 * `beforeinstallprompt` before any React effect runs.
 */
export function initInstallPromptCapture(target: Window = window) {
  if (captureTarget) return;
  captureTarget = target;
  target.addEventListener('beforeinstallprompt', (event) => {
    // Suppress the browser's own mini-infobar; the app offers the prompt at a better moment.
    event.preventDefault();
    updateSnapshot({ deferredPrompt: event });
  });
  target.addEventListener('appinstalled', () => updateSnapshot({ deferredPrompt: null, installed: true }));
}

export function subscribeInstallCapture(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getInstallCaptureSnapshot() {
  return snapshot;
}

/** Hands out the captured event once, since a second prompt() call would throw. */
export function takeDeferredInstallPrompt() {
  const { deferredPrompt } = snapshot;
  if (deferredPrompt) updateSnapshot({ deferredPrompt: null });
  return deferredPrompt;
}
