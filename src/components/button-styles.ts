/** Button styles shared by Settings (Progress, Backup & sync, Install app) and its dialogs, so they all match. */

export type ButtonTone = 'primary' | 'secondary' | 'neutral' | 'danger';

const TONES: Record<ButtonTone, string> = {
  primary: 'bg-emerald-700 text-white hover:bg-emerald-800 dark:bg-emerald-600 dark:hover:bg-emerald-500',
  secondary: 'border border-slate-300 hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800',
  neutral: 'bg-slate-900 text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white',
  danger: 'bg-red-600 text-white hover:bg-red-700'
};

export function buttonClass(tone: ButtonTone) {
  return `min-h-11 rounded-xl px-4 py-2 text-sm font-medium ${TONES[tone]}`;
}

/**
 * Every Settings action, a passkey's Remove included, is the same size whatever its label: full width on phones, and
 * at least 14rem wide beside each other on larger screens.
 */
export const SECTION_BUTTON = 'w-full sm:w-auto sm:min-w-56';
