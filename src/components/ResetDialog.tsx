import { useEffect } from 'react';

interface ResetDialogProps {
  onCancel: () => void;
  onConfirm: () => void;
}

export function ResetDialog({ onCancel, onConfirm }: ResetDialogProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  return (
    <div className="reset-confirmation-backdrop">
      <section
        aria-labelledby="reset-confirmation-title"
        aria-modal="true"
        className="reset-confirmation-dialog rounded-2xl border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900"
        role="dialog"
      >
        <h2 className="text-lg font-semibold" id="reset-confirmation-title">Reset all progress?</h2>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          This permanently clears your recorded routes and cannot be undone. Are you sure?
        </p>
        <div className="mt-5 flex justify-end gap-3">
          <button autoFocus className="min-h-11 rounded-xl border border-slate-300 px-4 py-2 text-sm dark:border-slate-600" onClick={onCancel}>
            Cancel
          </button>
          <button className="min-h-11 rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white" onClick={onConfirm}>
            Reset progress
          </button>
        </div>
      </section>
    </div>
  );
}
