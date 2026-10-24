import type { PlatypusApi } from "../shared/types";

declare global {
  interface Window {
    platypus: PlatypusApi;
  }
}

export {};
