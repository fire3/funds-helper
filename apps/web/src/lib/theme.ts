import { useEffect, useState } from 'react';

const STORAGE_KEY = 'funds-helper-theme';

function apply(dark: boolean): void {
  document.documentElement.classList.toggle('dark', dark);
  try {
    localStorage.setItem(STORAGE_KEY, dark ? 'dark' : 'light');
  } catch {
    /* 隐私模式下 localStorage 可能不可用，忽略 */
  }
}

/** 当前是否深色。用 MutationObserver 跟随 <html> 的 class，避免层层透传 */
export function useIsDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));

  useEffect(() => {
    const target = document.documentElement;
    const observer = new MutationObserver(() => setDark(target.classList.contains('dark')));
    observer.observe(target, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return dark;
}

export function useTheme(): { dark: boolean; toggle: () => void } {
  const dark = useIsDark();
  return { dark, toggle: () => apply(!dark) };
}
