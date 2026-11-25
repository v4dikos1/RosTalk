import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { coreApi } from "@/core";
import {
  contextMenuActions,
  type ContextMenuAction,
} from "@/lib/contextMenu";

type TextControl = HTMLInputElement | HTMLTextAreaElement;

interface MenuState {
  x: number;
  y: number;
  /** The field the menu acts on, if any. */
  control: TextControl | null;
  /** A contenteditable host, for rich-text fields. */
  editableHost: HTMLElement | null;
  /** Selection captured when the menu opened; clicking a button moves focus. */
  selection: { start: number; end: number } | null;
  actions: ContextMenuAction[];
}

function isTextControl(element: HTMLElement | null): element is TextControl {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

/** Nearest field or contenteditable host, so a click on a child still works. */
function findEditable(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) {
    return null;
  }
  if (isTextControl(target)) {
    return target;
  }
  const host = target.closest<HTMLElement>("[contenteditable='true']");
  return host ?? null;
}

/** Whether a text field has a real selection. */
function controlHasSelection(control: TextControl): boolean {
  return (control.selectionEnd ?? 0) > (control.selectionStart ?? 0);
}

/**
 * Replaces the selection through the native value setter.
 *
 * `execCommand("insertText")` covers contenteditable and plain inputs; this
 * fallback keeps React controlled inputs in sync because it dispatches the
 * `input` event React listens to.
 */
function replaceSelection(control: TextControl, text: string): void {
  const start = control.selectionStart ?? control.value.length;
  const end = control.selectionEnd ?? start;
  const next = control.value.slice(0, start) + text + control.value.slice(end);
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(control, next);
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.setSelectionRange(start + text.length, start + text.length);
}

function focusTarget(state: MenuState): HTMLElement | null {
  const target = state.control ?? state.editableHost;
  if (!target) {
    return null;
  }
  target.focus();
  // Clicking a menu item moves the focus away from the field; put the caret
  // back where the user right-clicked so cut/copy/paste act on the right span.
  if (state.control && state.selection) {
    try {
      state.control.setSelectionRange(
        state.selection.start,
        state.selection.end,
      );
    } catch {
      // Input types such as `number` do not expose a text selection.
    }
  }
  return target;
}

/** `execCommand` is absent in jsdom; the guard keeps the menu testable. */
function execCommand(command: string, value?: string): boolean {
  if (typeof document.execCommand !== "function") {
    return false;
  }
  return document.execCommand(command, false, value);
}

async function runAction(
  action: ContextMenuAction,
  state: MenuState,
): Promise<void> {
  const target = focusTarget(state);
  switch (action) {
    case "cut":
      execCommand("cut");
      break;
    case "copy":
      execCommand("copy");
      break;
    case "selectAll":
      if (state.control) {
        state.control.select();
      } else {
        execCommand("selectAll");
      }
      break;
    case "paste": {
      // Chromium refuses execCommand("paste") without a permission prompt the
      // desktop shell cannot show, so the text comes from the OS clipboard.
      const text = await coreApi.readClipboardText().catch(() => "");
      if (!text || !target) {
        return;
      }
      if (state.control) {
        if (!execCommand("insertText", text)) {
          replaceSelection(state.control, text);
        }
      } else {
        execCommand("insertText", text);
      }
      break;
    }
  }
}

const LABEL_KEYS: Record<ContextMenuAction, string> = {
  cut: "contextMenu.cut",
  copy: "contextMenu.copy",
  paste: "contextMenu.paste",
  selectAll: "contextMenu.selectAll",
};

/**
 * Page-wide handler that suppresses the browser context menu and shows the
 * small Cut/Copy/Paste/Select all replacement.
 *
 * Mounted once by the app root, so every screen and dialog uses it.
 */
export function ContextMenu() {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onContextMenu(event: MouseEvent) {
      // Also suppresses the menu in a browser preview, not only in WebView2.
      event.preventDefault();
      const editable = findEditable(event.target);
      const hasSelection = editable
        ? isTextControl(editable)
          ? controlHasSelection(editable)
          : (window.getSelection()?.toString().length ?? 0) > 0
        : (window.getSelection()?.toString().length ?? 0) > 0;
      const actions = contextMenuActions({
        editable: editable !== null,
        hasSelection,
      });
      if (actions.length === 0) {
        setMenu(null);
        return;
      }
      setMenu({
        x: event.clientX,
        y: event.clientY,
        control: isTextControl(editable) ? editable : null,
        editableHost: editable && !isTextControl(editable) ? editable : null,
        selection: isTextControl(editable)
          ? {
              start: editable.selectionStart ?? 0,
              end: editable.selectionEnd ?? 0,
            }
          : null,
        actions,
      });
    }

    const close = () => setMenu(null);
    document.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
    };
  }, []);

  if (!menu) {
    return null;
  }

  // The menu is a Radix DropdownMenu anchored to the click point: it is
  // portalled, flips and shifts to stay inside the window instead of being
  // clamped by hand (playtest-1, complaint 23).
  return (
    <DropdownMenu
      open
      onOpenChange={(open) => {
        if (!open) {
          setMenu(null);
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          style={{
            position: "fixed",
            left: menu.x,
            top: menu.y,
            width: 1,
            height: 1,
          }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        ref={menuRef}
        role="menu"
        data-testid="context-menu"
        align="start"
        className="min-w-40 rounded-sm p-1 shadow-lg"
      >
        {menu.actions.map((action) => (
          <DropdownMenuItem
            key={action}
            data-testid={`context-menu-${action}`}
            onSelect={() => {
              const state = menu;
              setMenu(null);
              void runAction(action, state);
            }}
          >
            {t(LABEL_KEYS[action])}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
