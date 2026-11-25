import { ImagePlus, Trash2, X } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { coreApi } from "@/core";
import type { ChatProxyView } from "@/core/api";
import {
  AVATAR_SIZE,
  AvatarHttpError,
  MAX_AVATAR_BYTES,
  avatarErrorKey,
  avatarMaxOffset,
  canvasToAvatar,
  drawAvatarCrop,
  removeAvatar,
  uploadAvatar,
} from "@/lib/avatars";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/store/chatStore";
import { useCoreStore } from "@/store/coreStore";

/** CSS pixels of the square preview. The canvas output is 256 px anyway. */
const VIEW = 240;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function errorKey(error: unknown): string {
  return avatarErrorKey(error);
}

async function resolveProxy(): Promise<ChatProxyView | null> {
  const existing = useChatStore.getState().proxy;
  if (existing) {
    return existing;
  }
  const proxy = await coreApi.chatProxy().catch(() => null);
  if (proxy) {
    useChatStore.getState().setProxy(proxy);
  }
  return proxy;
}

export interface AvatarDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Change-avatar dialog (stage P11): choose a picture, frame a square and send
 * the 256x256 PNG through the core's loopback proxy. Cropping happens locally
 * on a canvas, so only the final square leaves the machine.
 */
export function AvatarDialog({ open, onOpenChange }: AvatarDialogProps) {
  const { t } = useTranslation();
  const state = useCoreStore((store) => store.state);
  const self = state?.users.find((user) => user.id === state.selfUserId);
  const fileRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(
    null,
  );
  const [picture, setPicture] = useState<{
    image: HTMLImageElement;
    src: string;
    width: number;
    height: number;
  } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setPicture(null);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setError(null);
    setBusy(false);
  }

  function changeOpen(next: boolean) {
    if (!next) {
      reset();
    }
    onOpenChange(next);
  }

  function chooseFile() {
    setError(null);
    fileRef.current?.click();
  }

  function loadFile(file: File | undefined) {
    if (!file) {
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setError("avatar.errors.tooLarge");
      return;
    }
    if (
      file.type &&
      !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)
    ) {
      setError("avatar.errors.unsupported");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result);
      const image = new Image();
      image.onload = () => {
        if (!image.naturalWidth || !image.naturalHeight) {
          setError("avatar.errors.invalid");
          return;
        }
        setPicture({
          image,
          src,
          width: image.naturalWidth,
          height: image.naturalHeight,
        });
        setZoom(1);
        setOffset({ x: 0, y: 0 });
      };
      image.onerror = () => setError("avatar.errors.invalid");
      image.src = src;
    };
    reader.onerror = () => setError("avatar.errors.invalid");
    // A data URL keeps the preview inside the Tauri CSP (`img-src data:`);
    // a `blob:` URL is not in the policy and would render nothing.
    reader.readAsDataURL(file);
  }

  function pan(nextZoom: number, x: number, y: number) {
    if (!picture) {
      return { x, y };
    }
    const max = avatarMaxOffset(picture.width, picture.height, VIEW, nextZoom);
    return { x: clamp(x, -max.x, max.x), y: clamp(y, -max.y, max.y) };
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!picture) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      panX: offset.x,
      panY: offset.y,
    };
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current || !picture) {
      return;
    }
    setOffset(
      pan(
        zoom,
        drag.current.panX + (event.clientX - drag.current.x),
        drag.current.panY + (event.clientY - drag.current.y),
      ),
    );
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  async function save() {
    if (!picture || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = AVATAR_SIZE;
      canvas.height = AVATAR_SIZE;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("canvas");
      }
      drawAvatarCrop(context, picture.image, VIEW, zoom, offset.x, offset.y);
      const blob = await canvasToAvatar(canvas);
      const proxy = await resolveProxy();
      if (!proxy) {
        throw new AvatarHttpError(0, "network", "no proxy");
      }
      await uploadAvatar(proxy, blob);
      changeOpen(false);
    } catch (failure) {
      setError(errorKey(failure));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const proxy = await resolveProxy();
      if (!proxy) {
        throw new AvatarHttpError(0, "network", "no proxy");
      }
      await removeAvatar(proxy);
      changeOpen(false);
    } catch (failure) {
      setError(errorKey(failure));
    } finally {
      setBusy(false);
    }
  }

  const scale = picture
    ? (VIEW / Math.min(picture.width, picture.height)) * zoom
    : 1;
  const shownWidth = picture ? picture.width * scale : VIEW;
  const shownHeight = picture ? picture.height * scale : VIEW;

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        className="w-[min(430px,92vw)]"
        showClose={false}
        data-testid="avatar-dialog"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <DialogTitle className="text-[13px] font-semibold text-foreground">
              {t("avatar.title")}
            </DialogTitle>
            <DialogDescription className="text-[11px] text-faint">
              {t("avatar.hint")}
            </DialogDescription>
          </div>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={() => changeOpen(false)}
            className="inline-flex size-7 items-center justify-center rounded-sm text-muted hover:bg-hover hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div className="space-y-3 p-4">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="sr-only"
            data-testid="avatar-file-input"
            onChange={(event) => {
              loadFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={chooseFile}>
              <ImagePlus className="size-3.5" aria-hidden />
              {t("avatar.choose")}
            </Button>
            {self?.avatarHash ? (
              <Button
                size="sm"
                variant="ghost"
                className="text-danger hover:text-danger"
                disabled={busy}
                onClick={() => void clear()}
                data-testid="avatar-remove"
              >
                <Trash2 className="size-3.5" aria-hidden />
                {t("avatar.remove")}
              </Button>
            ) : null}
          </div>

          <div
            ref={viewRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            className={cn(
              "relative mx-auto overflow-hidden rounded-lg border border-border bg-background",
              picture ? "cursor-grab active:cursor-grabbing" : "cursor-default",
            )}
            style={{ width: VIEW, height: VIEW }}
            data-testid="avatar-crop"
          >
            {picture ? (
              <img
                src={picture.src}
                alt=""
                draggable={false}
                data-testid="avatar-crop-image"
                className="pointer-events-none absolute max-w-none select-none"
                style={{
                  width: shownWidth,
                  height: shownHeight,
                  left: (VIEW - shownWidth) / 2 + offset.x,
                  top: (VIEW - shownHeight) / 2 + offset.y,
                }}
              />
            ) : (
              <span className="flex h-full items-center justify-center px-6 text-center text-[11px] text-faint">
                {t("avatar.empty")}
              </span>
            )}
          </div>

          {picture ? (
            <label className="flex items-center gap-3 text-[11px] text-muted">
              <span className="shrink-0">{t("avatar.zoom")}</span>
              <Slider
                min={1}
                max={3}
                step={0.05}
                value={zoom}
                aria-label={t("avatar.zoom")}
                data-testid="avatar-zoom"
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setZoom(next);
                  setOffset((current) => pan(next, current.x, current.y));
                }}
              />
            </label>
          ) : null}

          {error ? (
            <p role="alert" className="text-[11px] text-danger" data-testid="avatar-error">
              {t(error)}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <Button size="sm" variant="ghost" onClick={() => changeOpen(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={!picture || busy}
            onClick={() => void save()}
            data-testid="avatar-save"
          >
            {busy ? t("avatar.saving") : t("common.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
