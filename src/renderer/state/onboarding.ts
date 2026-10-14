import { useEffect, useRef, useState } from 'react';
import type { AppConfigView } from '@core/api';
import { ONBOARDING_VERSION, shouldShowOnboarding } from '@core/onboarding';

export type OnboardingStep = 'none' | 'welcome' | 'tour';

/**
 * Welcome screen + guided tour state. `beforeTour` runs when the tour starts, so the caller can put the UI into the state the tour points at
 * (sidebar open, one-session page).
 */
export function useOnboarding(config: AppConfigView | null, beforeTour: () => void) {
  const [onboarding, setOnboarding] = useState<OnboardingStep>('none');
  const checked = useRef(false);
  // first launch (or a newer tour version): show the welcome screen once per app start
  useEffect(() => {
    if (!config || checked.current) return;
    checked.current = true;
    void window.api.setupStatus().then((s) => {
      if (shouldShowOnboarding(config, ONBOARDING_VERSION, s.skipOnboarding)) setOnboarding('welcome');
    });
  }, [config]);
  // tray menu: "Show welcome & tour"
  useEffect(() => window.api.onShowOnboarding(() => setOnboarding('welcome')), []);
  const finish = () => {
    setOnboarding('none');
    void window.api.setConfig({ onboardingDone: true, onboardingVersion: ONBOARDING_VERSION });
  };
  const startTour = () => {
    beforeTour();
    setOnboarding('tour');
  };
  return { onboarding, setOnboarding, openWelcome: () => setOnboarding('welcome'), finish, startTour };
}
