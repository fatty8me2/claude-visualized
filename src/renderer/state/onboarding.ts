import { useEffect, useRef, useState } from 'react';
import type { AppConfigView } from '@core/api';
import { ONBOARDING_VERSION, shouldShowOnboarding } from '@core/onboarding';
import { resumeStep, SETUP_VERSION, shouldShowSetup } from '@core/setupWizard';

export type OnboardingStep = 'none' | 'setup' | 'welcome' | 'tour';

/**
 * First-run setup wizard + welcome checklist + guided tour state. `beforeTour` runs when the tour starts, so the caller can put the UI
 * into the state the tour points at (sidebar open, one-session page).
 */
export function useOnboarding(config: AppConfigView | null, beforeTour: () => void) {
  const [onboarding, setOnboarding] = useState<OnboardingStep>('none');
  /** the wizard step to open on: saved progress when resuming, 0 for "run setup again" */
  const [setupStart, setSetupStart] = useState(0);
  const checked = useRef(false);
  const cfg = useRef(config);
  cfg.current = config;
  // first launch (or a newer wizard version): show the wizard once per app start
  useEffect(() => {
    if (!config || checked.current) return;
    checked.current = true;
    void window.api.setupStatus().then((s) => {
      if (shouldShowSetup(config, SETUP_VERSION, s.skipOnboarding)) {
        setSetupStart(resumeStep(config.setupStep));
        setOnboarding('setup');
      } else if (shouldShowOnboarding(config, ONBOARDING_VERSION, s.skipOnboarding)) setOnboarding('welcome');
    });
  }, [config]);
  const openSetup = (fresh: boolean) => {
    setSetupStart(fresh ? 0 : resumeStep(cfg.current?.setupStep));
    setOnboarding('setup');
  };
  // tray menu: "Show welcome & tour"
  useEffect(() => window.api.onShowOnboarding(() => openSetup(false)), []);
  const finish = () => {
    setOnboarding('none');
    void window.api.setConfig({ onboardingDone: true, onboardingVersion: ONBOARDING_VERSION });
  };
  const startTour = () => {
    beforeTour();
    setOnboarding('tour');
  };
  return {
    onboarding,
    setOnboarding,
    setupStart,
    /** the old welcome checklist (Settings) */
    openWelcome: () => setOnboarding('welcome'),
    /** the setup wizard: help menu resumes, "Run setup again" starts over */
    openSetup,
    finish,
    startTour,
  };
}
