import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const current = (): Theme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

/** The page theme ('light' or 'dark'). Re-renders when the user switches it. */
export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(current);
  useEffect(() => {
    const on = () => setTheme(current());
    window.addEventListener('themechange', on);
    return () => window.removeEventListener('themechange', on);
  }, []);
  return theme;
}

/** Read a CSS custom property from :root, e.g. cssVar('--stage-empty'). For canvas drawing. */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
