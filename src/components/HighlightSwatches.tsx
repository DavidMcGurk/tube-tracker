import type { ProgressStyle } from '../lib/types';

/** The legend's sample lines use a real line colour (the Central line's red), so they read as lines on the map. */
const SAMPLE_LINE_COLOUR = '#DC241F';

/** A short line at the given width, as the map draws travelled (bold) or untravelled (thin) track. */
function LineSwatch({ width }: { width: number }) {
  return (
    <svg className="h-3.5 w-[1.375rem] shrink-0" viewBox="0 0 22 14" aria-hidden="true">
      <path d="M3 7H19" stroke={SAMPLE_LINE_COLOUR} strokeWidth={width} strokeLinecap="round" />
    </svg>
  );
}

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
  // Travelled track is drawn bold.
  return <LineSwatch width={5.5} />;
}

/** Track not yet travelled, drawn thin (the bold-lines style only). */
export function UntravelledSwatch() {
  return <LineSwatch width={2} />;
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
