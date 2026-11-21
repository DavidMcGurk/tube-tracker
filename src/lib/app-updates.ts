import { registerSW } from 'virtual:pwa-register';

/** How often an open app checks for a new version, as well as each time it comes back to the foreground. */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Registers the service worker that keeps the app working offline. When a new version has been downloaded and has
 * taken over, the page reloads straight away so it shows the new version (vite-plugin-pwa's autoUpdate mode), instead
 * of the cached old one until the next launch.
 *
 * A Home Screen app is usually resumed rather than relaunched, so it also checks for a new version whenever it comes
 * back to the foreground, and hourly while it stays open.
 */
export function startAppUpdates() {
  registerSW({
    immediate: true,
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      const checkForUpdate = () => {
        if (!navigator.onLine) return;
        registration.update().catch((error: unknown) => console.warn('Unable to check for a new version', error));
      };
      setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkForUpdate();
      });
    },
    onRegisterError(error: unknown) {
      console.error('Unable to register the service worker', error);
    }
  });
}
