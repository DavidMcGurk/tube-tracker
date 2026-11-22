import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  detectInstallPlatform,
  getInstallCaptureSnapshot,
  getInstallPromptVariant,
  isStandalone,
  subscribeInstallCapture,
  takeDeferredInstallPrompt,
  type InstallPromptState
} from '../lib/install-prompt';
import { observeInstallPromptState, requestPersistentStorage, updateInstallPromptState } from '../lib/storage';
import { useMediaQuery } from './useMediaQuery';

/** The pop-up waits a moment after load so it never competes with the first look at the map. */
export const INSTALL_PROMPT_DELAY_MS = 2000;

function saveInstallPromptState(changes: InstallPromptState) {
  updateInstallPromptState(changes).catch((error: unknown) => console.error('Unable to save the install prompt state', error));
}

/**
 * Decides whether to offer installing the app, and how: Chromium's native prompt where it was captured, or
 * "Add to Home Screen" instructions on iOS. Dismissals and installs are persisted.
 */
export function useInstallPrompt() {
  const capture = useSyncExternalStore(subscribeInstallCapture, getInstallCaptureSnapshot, getInstallCaptureSnapshot);
  const coarsePointer = useMediaQuery('(pointer: coarse)');
  const displayModeStandalone = useMediaQuery('(display-mode: standalone)');
  const displayModeFullscreen = useMediaQuery('(display-mode: fullscreen)');
  const standalone = isStandalone({
    displayModeStandalone,
    displayModeFullscreen,
    navigatorStandalone: navigator.standalone === true
  });
  const [platform] = useState(() => detectInstallPlatform({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints }));
  const [loadedAt] = useState(() => Date.now());
  // Null until the stored state has loaded, so a returning visitor who dismissed the pop-up never sees it flash.
  const [stored, setStored] = useState<InstallPromptState | null>(null);
  const [delayElapsed, setDelayElapsed] = useState(false);
  const [dismissedThisSession, setDismissedThisSession] = useState(false);

  useEffect(() => observeInstallPromptState(setStored, (error) => {
    console.error('Unable to load the install prompt state', error);
    setStored({});
  }), []);

  useEffect(() => {
    const timer = window.setTimeout(() => setDelayElapsed(true), INSTALL_PROMPT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (capture.installed && stored && stored.installedAt === undefined) saveInstallPromptState({ installedAt: Date.now() });
  }, [capture.installed, stored]);

  // Installed apps ask for persistent storage as soon as they open. Browser tabs wait until a journey is recorded
  // (see useProgress), because Firefox shows a permission prompt for it.
  useEffect(() => {
    if (standalone) requestPersistentStorage();
  }, [standalone]);

  const installed = capture.installed || stored?.installedAt !== undefined;
  const variant = stored === null || dismissedThisSession ? null : getInstallPromptVariant({
    platform,
    hasDeferredPrompt: capture.deferredPrompt !== null,
    // A phone or tablet: judged by the device, not the window, so a narrow desktop window never gets the pop-up.
    isMobile: coarsePointer || platform !== 'other',
    standalone,
    dismissedAt: stored.dismissedAt,
    installed,
    now: loadedAt
  });

  const dismiss = useCallback(() => {
    setDismissedThisSession(true);
    saveInstallPromptState({ dismissedAt: Date.now() });
  }, []);

  const install = useCallback(async () => {
    const promptEvent = takeDeferredInstallPrompt();
    if (!promptEvent) return;
    try {
      await promptEvent.prompt();
      const { outcome } = await promptEvent.userChoice;
      if (outcome === 'accepted') saveInstallPromptState({ installedAt: Date.now() });
      else dismiss();
    } catch (error) {
      console.error('Unable to show the install prompt', error);
    }
  }, [dismiss]);

  return {
    platform,
    standalone,
    installed,
    canInstallNatively: capture.deferredPrompt !== null,
    /** The pop-up to show now, if any. */
    promptVariant: delayElapsed ? variant : null,
    dismiss,
    install
  };
}

export type InstallPromptController = ReturnType<typeof useInstallPrompt>;
