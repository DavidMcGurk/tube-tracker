import { useMemo } from 'react';
import { summariseProgress } from '../lib/progress';
import { formatKilometres, lineById } from '../lib/route-format';
import type { Progress } from '../lib/types';

const FALLBACK_LINE_COLOR = '#94a3b8';
/** Lines whose colour is unreadable on dark backgrounds use a theme-aware stand-in (see styles.css). */
const THEMED_LINE_COLORS: Record<string, string> = { northern: 'var(--tt-line-northern)' };
const NETWORK_COLOR = 'var(--tt-travelled)';

function percentOf(part: number, whole: number) {
  return whole > 0 ? (part / whole) * 100 : 0;
}

interface ProgressBarProps {
  label: string;
  detail: string;
  percent: number;
  color: string;
  ariaLabel: string;
}

export function ProgressBar({ label, detail, percent, color, ariaLabel }: ProgressBarProps) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-slate-600 dark:text-slate-300">
        <span>{label}</span>
        <span>{detail}</span>
      </div>
      <div
        className="flex h-3 overflow-hidden rounded-full border border-slate-400 bg-slate-200 dark:border-slate-500 dark:bg-slate-700"
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent * 10) / 10}
        aria-valuetext={detail}
      >
        <div className="h-full dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.3)]" style={{ width: `${percent}%`, backgroundColor: color }} />
        <div className="h-full flex-1 bg-slate-200 dark:bg-slate-700" />
      </div>
    </div>
  );
}

export function StatsView({ progress }: { progress: Progress }) {
  const stats = useMemo(() => summariseProgress(progress), [progress]);
  const sortedLineProgress = useMemo(
    () => [...stats.lineProgress].sort((a, b) => b.completion - a.completion || a.name.localeCompare(b.name)),
    [stats.lineProgress]
  );

  return (
    <main className="mx-auto max-w-6xl px-4 pb-10">
      <section className="rounded-3xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900" aria-labelledby="network-progress-title">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 id="network-progress-title" className="text-lg font-semibold">Whole network</h2>
          <span className="text-sm text-slate-600 dark:text-slate-300">
            {stats.completedLines} / {stats.lineProgress.length} lines completed
          </span>
        </div>
        <div className="space-y-3">
          <ProgressBar
            label="Track travelled"
            detail={`${stats.coverage.toFixed(1)}% · ${formatKilometres(stats.travelledDistance)} / ${formatKilometres(stats.totalDistance)} km`}
            percent={stats.coverage}
            color={NETWORK_COLOR}
            ariaLabel="Whole network track travelled"
          />
          <ProgressBar
            label="Stations visited"
            detail={`${percentOf(stats.uniqueStations, stats.totalStations).toFixed(1)}% · ${stats.uniqueStations} / ${stats.totalStations}`}
            percent={percentOf(stats.uniqueStations, stats.totalStations)}
            color={NETWORK_COLOR}
            ariaLabel="Whole network stations visited"
          />
        </div>
      </section>

      <div className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="mb-4 text-lg font-semibold">Line progress</h2>
        <div className="space-y-3">
          {sortedLineProgress.map((line) => {
            const lineColor = THEMED_LINE_COLORS[line.id] ?? lineById.get(line.id)?.color ?? FALLBACK_LINE_COLOR;
            return (
              <div key={line.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                <div className="mb-2 flex items-center gap-3">
                  <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: lineColor }} />
                  <span className="font-medium">{line.name}</span>
                </div>
                <div className="space-y-3">
                  <ProgressBar
                    label="Line travelled"
                    detail={`${line.completion.toFixed(1)}% · ${formatKilometres(line.travelledDistance)} / ${formatKilometres(line.totalDistance)} km`}
                    percent={line.completion}
                    color={lineColor}
                    ariaLabel={`${line.name} distance travelled`}
                  />
                  <ProgressBar
                    label="Stations visited"
                    detail={`${line.stationCompletion.toFixed(1)}% · ${line.visitedStations} / ${line.totalStations}`}
                    percent={line.stationCompletion}
                    color={lineColor}
                    ariaLabel={`${line.name} stations visited`}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}
