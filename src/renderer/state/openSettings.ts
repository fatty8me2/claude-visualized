import { useEffect, useState } from 'react';

/** Settings dialog visibility. The tray's "Open settings" is either pushed, or waiting for us if the window was still loading. */
export function useOpenSettings(): [boolean, (open: boolean) => void] {
  const [showSettings, setShowSettings] = useState(false);
  useEffect(() => {
    void window.api.takeOpenSettings().then((pending) => pending && setShowSettings(true));
    return window.api.onOpenSettings(() => setShowSettings(true));
  }, []);
  return [showSettings, setShowSettings];
}
