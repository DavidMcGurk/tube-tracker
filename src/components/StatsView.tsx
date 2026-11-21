import { useMemo } from 'react';
import { summariseProgress } from '../lib/progress';
import { formatKilometres, lineById } from '../lib/route-format';
import type { Progress } from '../lib/types';

const FALLBACK_LINE_COLOR = '#94a3b8';

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-2 text-3xl font-semibold">{value}</p>
    </div>
  );
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
        aria-valuenow={percent}
      >
        <div className="h-full" style={{ width: `${percent}%`, backgroundColor: color }} />
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
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Travelled distance" value={`${formatKilometres(stats.travelledDistance)} km`} />
        <StatCard label="Network coverage" value={`${stats.coverage.toFixed(1)}%`} />
        <StatCard label="Stations visited" value={stats.uniqueStations} />
        <StatCard label="Completed lines" value={stats.completedLines} />
      </div>

      <div className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <h3 className="mb-4 text-lg font-semibold">Line progress</h3>
        <div className="space-y-3">
          {sortedLineProgress.map((line) => {
            const lineColor = lineById.get(line.id)?.color ?? FALLBACK_LINE_COLOR;
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
