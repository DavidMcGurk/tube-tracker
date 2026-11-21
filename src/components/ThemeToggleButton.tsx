import type { ResolvedTheme } from '../lib/types';
import { ThemeIcon } from './icons';

interface ThemeToggleButtonProps {
  resolvedTheme: ResolvedTheme;
  onToggle: () => void;
  className?: string;
}

export function ThemeToggleButton({ resolvedTheme, onToggle, className = '' }: ThemeToggleButtonProps) {
  const label = `Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} mode`;
  return (
    <button
      className={`min-h-11 min-w-11 rounded-full border border-slate-300 p-2 dark:border-slate-700 ${className}`}
      onClick={onToggle}
      aria-label={label}
      title={label}
    >
      <ThemeIcon resolvedTheme={resolvedTheme} />
    </button>
  );
}
