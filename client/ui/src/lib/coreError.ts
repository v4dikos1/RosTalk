import type { CoreError } from "@/core/api";

/** Normalises a rejected IPC value into a `CoreError`. */
export function asCoreError(error: unknown): CoreError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error
  ) {
    return error as CoreError;
  }
  return {
    code: "internal",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
    actionUrl: null,
    serverCode: null,
  };
}

/**
 * i18n key for a core error. The UI never shows the English technical message
 * from the core; it maps the stable code (and the server code for rejected
 * requests) to a localised string.
 */
export function coreErrorKey(error: CoreError): string {
  if (error.code === "serverError" && error.serverCode) {
    return `errors.server.${error.serverCode}`;
  }
  return `errors.core.${error.code}`;
}

/** Localised text plus the technical detail for a tooltip. */
export interface CoreErrorText {
  key: string;
  detail: string;
}

export function coreErrorText(error: CoreError): CoreErrorText {
  return { key: coreErrorKey(error), detail: error.message };
}

/**
 * Server refusals that will not change by pressing the same button again.
 * The core cannot know this per code, so the UI owns the list.
 */
const PERMANENT = new Set([
  "permissionDenied",
  "hierarchy",
  "kicked",
  "banned",
  "inviteInvalid",
  "inviteExpired",
  "wrongPassword",
  "channelPasswordInvalid",
  "notFound",
  "unauthenticated",
  "protocolVersionUnsupported",
]);

export function isRetryable(error: CoreError): boolean {
  if (error.serverCode && PERMANENT.has(error.serverCode)) {
    return false;
  }
  return error.retryable;
}
