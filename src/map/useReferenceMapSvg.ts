import { useEffect, useState } from 'react';
import referenceMapUrl from '../assets/reference-map-clean.svg?url';

let loadedMarkup = '';
let pendingLoad: Promise<string> | null = null;

/** Fetches the map once per page; later mounts (e.g. returning to the Map tab) get it synchronously. */
function loadReferenceMap() {
  pendingLoad ??= fetch(referenceMapUrl)
    .then((response) => {
      if (!response.ok) throw new Error(`Map request failed with status ${response.status}`);
      return response.text();
    })
    .then((markup) => {
      if (!markup.includes('<svg')) throw new Error('The map asset did not contain an SVG document');
      loadedMarkup = markup;
      return markup;
    })
    .catch((error: unknown) => {
      pendingLoad = null;
      throw error;
    });
  return pendingLoad;
}

export function useReferenceMapSvg() {
  const [markup, setMarkup] = useState(loadedMarkup);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (markup) return;
    let cancelled = false;
    loadReferenceMap()
      .then((loaded) => { if (!cancelled) setMarkup(loaded); })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Unable to load the map');
      });
    return () => { cancelled = true; };
  }, [markup]);

  return { markup, error };
}
