import { useSyncExternalStore } from 'react';
import { emptyLocalView, findLoadedModel, localWindowFor, type LocalLink, type LocalModelsView } from '@core/localModels';
import type { LocalWindow } from '@core/context';

// One shared copy of the main process's local-server status for every component in this window.
let view: LocalModelsView = emptyLocalView();
let started = false;
const subs = new Set<() => void>();

function set(v: LocalModelsView) {
  view = v;
  subs.forEach((f) => f());
}

function start() {
  if (started || typeof window === 'undefined' || !window.api) return;
  started = true;
  void window.api.getLocalModels().then(set);
  window.api.onLocalModels(set);
}

function subscribe(cb: () => void) {
  start();
  subs.add(cb);
  return () => subs.delete(cb);
}

export function useLocalModels(): LocalModelsView {
  return useSyncExternalStore(subscribe, () => view);
}

export function useLocalLink(model: string | null | undefined): LocalLink | null {
  return findLoadedModel(model, useLocalModels().servers);
}

export function useLocalWindow(model: string | null | undefined): LocalWindow | null {
  return localWindowFor(model, useLocalModels().servers);
}
