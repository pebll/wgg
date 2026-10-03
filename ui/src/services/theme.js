/*
 * Theme handling: Semi UI switches themes on the `theme-mode` attribute of <body>. The default follows
 * the system preference; the toggle overrides it and is remembered in localStorage (best effort).
 */

const KEY = 'wgg-theme';

export const resolveTheme = (stored, prefersDark) =>
  stored === 'dark' || stored === 'light' ? stored : prefersDark ? 'dark' : 'light';

export const nextTheme = (theme) => (theme === 'dark' ? 'light' : 'dark');

export function loadStored(key = KEY) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function saveStored(value, key = KEY) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable (private mode, blocked): the choice just is not remembered
  }
}

export function systemPrefersDark() {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

export function applyTheme(theme) {
  document.body.setAttribute('theme-mode', theme);
  document.documentElement.style.colorScheme = theme;
}

export function initialTheme() {
  return resolveTheme(loadStored(), systemPrefersDark());
}
