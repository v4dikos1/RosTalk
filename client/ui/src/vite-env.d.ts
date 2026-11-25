/// <reference types="vite/client" />

/**
 * GitHub repository of the releases, `owner/name` (P13, ADR 0026). Injected by
 * vite.config.ts from `ROSTALK_RELEASE_REPO` (`make release RELEASE_REPO=…`).
 */
declare const __ROSTALK_RELEASE_REPO__: string;
