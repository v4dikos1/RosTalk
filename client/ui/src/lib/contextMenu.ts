/**
 * Items of the custom context menu.
 *
 * The WebView2 context menu is disabled in the shell (stage 2.3.1); this menu
 * replaces the useful part of it in text fields and for selected text. Keyboard
 * copy/paste keeps working on its own.
 */
export type ContextMenuAction = "cut" | "copy" | "paste" | "selectAll";

/** Actions for the current target; an empty list means "show nothing". */
export function contextMenuActions(input: {
  editable: boolean;
  hasSelection: boolean;
}): ContextMenuAction[] {
  if (input.editable) {
    return input.hasSelection
      ? ["cut", "copy", "paste", "selectAll"]
      : ["paste", "selectAll"];
  }
  // Read-only text can still be copied through the browser selection.
  return input.hasSelection ? ["copy"] : [];
}
