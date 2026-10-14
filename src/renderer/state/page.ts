import { useState } from 'react';
import { DEFAULT_PAGE, isPageId, type PageId } from '../views/pages';

const KEY = 'cvis.page';

/** The page shown next to the sidebar (remembered per machine). Valid ids are the entries of PAGES. */
export function usePage(): [PageId, (p: PageId) => void] {
  const [page, setState] = useState<PageId>(() => {
    try {
      const p = localStorage.getItem(KEY);
      return p && isPageId(p) ? p : DEFAULT_PAGE;
    } catch {
      return DEFAULT_PAGE;
    }
  });
  const setPage = (p: PageId) => {
    setState(p);
    try {
      localStorage.setItem(KEY, p);
    } catch {
      /* storage unavailable */
    }
  };
  return [page, setPage];
}
