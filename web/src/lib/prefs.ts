/** Per-device conveniences only (theme, last branch). Never personal or schedule data. */
export type ThemePref = 'system' | 'light' | 'dark';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the preference simply is not remembered */
  }
}

export function getTheme(): ThemePref {
  const v = read('fc.theme');
  return v === 'light' || v === 'dark' ? v : 'system';
}

export function applyTheme(t: ThemePref) {
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
  write('fc.theme', t);
}

export const getLastBranch = () => read('fc.branch');
export const setLastBranch = (id: string) => write('fc.branch', id);
export const getRailOpen = () => read('fc.rail') === '1';
export const setRailOpen = (v: boolean) => write('fc.rail', v ? '1' : '0');
