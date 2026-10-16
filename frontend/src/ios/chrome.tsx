import { createContext, useContext, useEffect } from 'react';

/**
 * Lets a phone screen tell the app shell it draws its own navigation bar
 * (Screen does), so the shell drops its generic top bar. Pages not yet built
 * on the iOS layer keep the shell's bar.
 */
export const PhoneChromeContext = createContext<{ setOwnHeader: (own: boolean) => void }>({ setOwnHeader: () => {} });

export function useOwnHeader(active = true) {
  const { setOwnHeader } = useContext(PhoneChromeContext);
  useEffect(() => {
    if (!active) return;
    setOwnHeader(true);
    return () => setOwnHeader(false);
  }, [active, setOwnHeader]);
}

/** The element the page scrolls in (the shell's <main>), or the document. */
export function scrollRootOf(el: Element | null): HTMLElement {
  return (el?.closest('[data-scroll-root]') as HTMLElement | null) ?? (document.scrollingElement as HTMLElement);
}
