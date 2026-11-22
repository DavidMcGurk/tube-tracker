import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void) {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** Whether the browser thinks it's online. Only `false` is reliable: "online" can still mean no route to a server. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, () => navigator.onLine !== false, () => true);
}
