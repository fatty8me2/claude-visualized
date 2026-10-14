import { useState } from 'react';

const KEY = 'cvis.activeOnly';

/** "Active only": hide recent sessions and finished agents everywhere (remembered per machine). */
export function useActiveOnly(): [boolean, (on: boolean) => void] {
  const [activeOnly, setState] = useState(() => {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  });
  const setActiveOnly = (on: boolean) => {
    setState(on);
    try {
      localStorage.setItem(KEY, on ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  };
  return [activeOnly, setActiveOnly];
}
