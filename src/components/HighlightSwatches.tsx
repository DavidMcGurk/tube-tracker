import type { ProgressStyle } from '../lib/types';

/** A small picture of how travelled track looks on the map in the given style. */
export function TravelledSwatch({ progressStyle }: { progressStyle: ProgressStyle }) {
  if (progressStyle === 'band') {
    // The yellow band, its casing strip, and the line itself.
    return (
      <span className="relative inline-flex h-3 w-7 shrink-0 items-center" aria-hidden="true">
        <span className="absolute inset-0 rounded-full bg-(--tt-travelled) opacity-(--tt-travelled-opacity)" />
        <span className="absolute inset-x-0.5 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-(--tt-highlight-casing)" />
        <span className="absolute inset-x-1 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-slate-700 dark:bg-slate-200" />
      </span>
    );
  }
  // A thin untravelled line becoming a full-width travelled one.
  return (
    <svg className="h-3 w-7 shrink-0 text-slate-700 dark:text-slate-200" viewBox="0 0 28 12" aria-hidden="true">
      <path d="M1 6H12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M13 6H26" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" />
    </svg>
  );
}

/** A small picture of the selected route: an orange dashed path with an edge, drawn over the lines. */
export function PreviewSwatch() {
  return (
    <svg className="h-3 w-7 shrink-0" viewBox="0 0 28 12" aria-hidden="true">
      <path d="M2 6H26" stroke="var(--tt-preview-edge)" strokeWidth="7" strokeLinecap="round" />
      <path d="M3 6H25" stroke="var(--tt-preview)" strokeWidth="4" strokeDasharray="5 3" />
    </svg>
  );
}
