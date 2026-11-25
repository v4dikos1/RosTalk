import { coreApi } from "@/core";

/**
 * Reports one crashed React panel.
 *
 * The diagnostics log gets the panel name, the error message and the component
 * stack only: no tokens, keys, message text or other user data. A failure to
 * write the log must never become a second error.
 */
export function reportUiError(
  scope: string,
  error: unknown,
  componentStack?: string | null,
): void {
  // Dev builds and the browser fixture have no file log; the console line is
  // still useful there.
  console.error(`[ui:${scope}]`, error);

  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  void coreApi
    .logUiError(scope, message, componentStack ?? null)
    .catch(() => {
      // Diagnostics are optional; losing one line is not worth another crash.
    });
}
