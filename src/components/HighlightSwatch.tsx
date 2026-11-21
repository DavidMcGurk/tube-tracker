/** A small picture of a highlighted line: the band, its casing strip, and the line itself. */
export function HighlightSwatch({ band, opacity }: { band: string; opacity: string }) {
  return (
    <span className="relative inline-flex h-3 w-7 shrink-0 items-center" aria-hidden="true">
      <span className={`absolute inset-0 rounded-full ${band} ${opacity}`} />
      <span className="absolute inset-x-0.5 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-(--tt-highlight-casing)" />
      <span className="absolute inset-x-1 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-slate-700 dark:bg-slate-200" />
    </span>
  );
}
