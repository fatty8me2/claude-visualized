import type { VisApi } from '@core/api';

declare global {
  interface Window {
    api: VisApi;
  }
}

export {};
