/**
 * Light or dark. Dark is Sollux's original look and stays the default;
 * light follows the utility statement's palette (see styles/theme-light.css).
 * "system" follows the device. The choice is kept in this browser only.
 *
 * index.html applies the stored choice before the app loads, so a light
 * page never flashes dark first; this module keeps it in step afterwards.
 */
import { useEffect, useState } from 'react';
import { setStatusBarTheme } from './native';

export type ThemeChoice = 'dark' | 'light' | 'system';
export type Theme = 'dark' | 'light';

const KEY = 'sollux.theme';
const PAPER = '#f8f6f3';
const DARK = '#1e1e1e';

export function storedChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'system' ? v : 'dark';
  } catch { return 'dark'; }
}

function systemTheme(): Theme {
  try { return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; } catch { return 'dark'; }
}

export function resolve(choice: ThemeChoice): Theme {
  return choice === 'system' ? systemTheme() : choice;
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? PAPER : DARK);
  // Inside the iOS shell the status bar text must contrast with the page.
  void setStatusBarTheme(theme);
}

export function setThemeChoice(choice: ThemeChoice): void {
  try { localStorage.setItem(KEY, choice); } catch { /* private mode: applies for this visit only */ }
  applyTheme(resolve(choice));
  window.dispatchEvent(new CustomEvent('sollux-theme', { detail: choice }));
}

/** Call once at startup: applies the choice and follows the device when on "system". */
export function initTheme(): void {
  applyTheme(resolve(storedChoice()));
  try {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (storedChoice() === 'system') applyTheme(systemTheme());
    });
  } catch { /* old browsers */ }
}

/** The current choice, updated when it changes anywhere in the app. */
export function useThemeChoice(): [ThemeChoice, (c: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(storedChoice);
  useEffect(() => {
    const on = (e: Event) => setChoice((e as CustomEvent<ThemeChoice>).detail);
    window.addEventListener('sollux-theme', on);
    return () => window.removeEventListener('sollux-theme', on);
  }, []);
  return [choice, setThemeChoice];
}
