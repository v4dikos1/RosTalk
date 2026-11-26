import { MonitorUp } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  STREAM_PRESETS,
  type NativePresetName,
  type NativeStreamSupport,
  type StreamPresetName,
} from "@/features/streams/engine";
import { coreApi, isDesktop } from "@/core";
import { cn } from "@/lib/utils";
import { useCoreStore } from "@/store/coreStore";
import { useStreamStore } from "@/store/streamStore";

export interface StreamStartDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: number;
  /** Advised by the server with the stream credentials; hidden until known. */
  presets?: string[];
}

const DEFAULT_PRESETS: StreamPresetName[] = ["720p30", "1080p30"];
const NATIVE_PRESETS: NativePresetName[] = ["720p30", "1080p30"];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Preset and game/text selection before the capture picker opens. */
export function StreamStartDialog({
  open,
  onOpenChange,
  channelId,
  presets,
}: StreamStartDialogProps) {
  const { t } = useTranslation();
  const permissions = useCoreStore((core) => core.state?.permissions);
  const error = useStreamStore((stream) => stream.error);
  const streaming = useStreamStore((stream) => stream.local.streaming);
  const nativeStatus = useStreamStore((stream) => stream.local.nativeStatus);
  const start = useStreamStore((stream) => stream.start);
  const [preset, setPreset] = useState<StreamPresetName>("1080p30");
  const [audio, setAudio] = useState(true);
  const [busy, setBusy] = useState(false);
  // The native path is explicit and off by default until the G7 run and the
  // release decision. It is never chosen automatically.
  const [native, setNative] = useState(false);
  const [nativeSupport, setNativeSupport] =
    useState<NativeStreamSupport | null>(
      isDesktop
        ? null
        : {
            supported: false,
            cursorCaptureAvailable: false,
            borderApiAvailable: false,
            reason: "native capture is available only in the desktop client",
          },
    );
  // Reset the experimental mode every time the dialog is opened, without an
  // effect that would cascade a render.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setNative(false);
    }
  }
  // Stage P15: can the core capture the computer audio without RosTalk? Until
  // it answers the switch is labelled neutrally; "no" means the WebView
  // fallback, and the dialog says that friends will hear themselves.
  const [coreAudio, setCoreAudio] = useState<"checking" | "yes" | "no">(
    isDesktop ? "checking" : "no",
  );

  useEffect(() => {
    if (!open || !isDesktop) {
      return;
    }
    let cancelled = false;
    coreApi
      .streamAudioSupport()
      .then((support) => {
        if (!cancelled) {
          setCoreAudio(support.supported ? "yes" : "no");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCoreAudio("no");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Every open probes the OS/API support; the result is not cached so an
  // upgrade from Windows 10 to 11 is reflected without a restart.
  useEffect(() => {
    if (!open || !isDesktop) {
      return;
    }
    let cancelled = false;
    coreApi
      .nativeStreamSupport()
      .then((support) => {
        if (!cancelled) {
          setNativeSupport(support);
        }
      })
      .catch((failure) => {
        if (!cancelled) {
          setNativeSupport({
            supported: false,
            cursorCaptureAvailable: false,
            borderApiAvailable: false,
            reason: messageOf(failure),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const changeNative = (value: boolean) => {
    setNative(value);
    // 720p30 is the gentle native preset; switching the mode on with a heavy
    // WebView2 preset must not silently keep it.
    if (value && !NATIVE_PRESETS.includes(preset as NativePresetName)) {
      setPreset("720p30");
    }
  };

  const channelPermissions =
    permissions?.channels.find((entry) => entry.channelId === channelId)
      ?.permissions ?? permissions?.server ?? [];
  const canStream = channelPermissions.includes("stream");
  const canHq = channelPermissions.includes("streamHq");
  const allowed = (presets as StreamPresetName[] | undefined)?.filter(
    (name) => name in STREAM_PRESETS,
  ) ?? DEFAULT_PRESETS;
  // The HQ permission adds the two heavy presets. A server that predates the
  // "source" preset simply does not advertise it, but the permission is the
  // real gate and the publish path has no server-side bitrate cap.
  const choices = [...allowed];
  if (canHq) {
    for (const name of ["1080p60", "source"] as StreamPresetName[]) {
      if (!choices.includes(name)) {
        choices.push(name);
      }
    }
  }
  const presetChoices = native
    ? choices.filter((name): name is NativePresetName =>
        NATIVE_PRESETS.includes(name as NativePresetName),
      )
    : choices;

  useEffect(() => {
    if (streaming) {
      onOpenChange(false);
    }
  }, [streaming, onOpenChange]);

  const submit = async (useNative = native) => {
    setBusy(true);
    try {
      await start({ preset, includeAudio: audio, native: useNative });
    } finally {
      setBusy(false);
    }
  };

  const nativeCancelled =
    error?.code === "captureCancelled" ||
    error?.code === "nativeSourceClosed" ||
    error?.code === "nativeEnded" ||
    error?.code === "nativeUnavailable" ||
    error?.code === "nativeError" ||
    error?.code === "nativeCursor";
  const nativeSupported = nativeSupport?.supported === true;
  const nativeProtected = nativeStatus !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(420px,92vw)] p-5">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-md bg-accent/15 text-accent">
            <MonitorUp className="size-4" aria-hidden />
          </span>
          <div>
            <DialogTitle className="text-[14px] font-semibold text-foreground">
              {t("streams.startTitle")}
            </DialogTitle>
            <DialogDescription className="text-[12px] text-muted">
              {t("streams.startHint")}
            </DialogDescription>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          <label className="grid grid-cols-[1fr_auto] items-center gap-3">
            <span className="text-[12px] text-muted">{t("streams.preset")}</span>
            <Select
              value={preset}
              onChange={(event) =>
                setPreset(event.target.value as StreamPresetName)
              }
              aria-label={t("streams.preset")}
              data-testid="stream-preset"
            >
              {presetChoices.map((name) => (
                <option key={name} value={name}>
                  {name === "source"
                    ? t("streams.presetSource")
                    : STREAM_PRESETS[name].label}
                </option>
              ))}
            </Select>
          </label>

          <label className="flex items-center justify-between gap-3">
            <span className="min-w-0">
              <span className="block text-[12px] text-muted">
                {t("streams.nativeMode")}
              </span>
              <span
                data-testid="stream-native-hint"
                className="block text-[11px] text-faint"
              >
                {!isDesktop
                  ? t("streams.nativeDesktopOnly")
                  : !nativeSupport
                    ? t("streams.nativeChecking")
                    : nativeSupport.supported
                      ? t("streams.nativeHint")
                      : (nativeSupport.reason ?? t("streams.nativeUnavailable"))}
              </span>
            </span>
            <Switch
              checked={native}
              onCheckedChange={changeNative}
              disabled={!isDesktop || !nativeSupported}
              aria-label={t("streams.nativeMode")}
              data-testid="stream-native-toggle"
            />
          </label>

          {native && nativeSupported ? (
            <div className="rounded-sm border border-accent/30 bg-accent/10 px-2.5 py-2 text-[11px] text-muted">
              <p>{t("streams.nativePickerHint")}</p>
              <p className="mt-1">
                {nativeSupport.borderApiAvailable
                  ? t("streams.nativeCursorHidden")
                  : t("streams.nativeBorderStays")}
              </p>
              {!nativeSupport.borderApiAvailable ? (
                <p className="mt-1">{t("streams.nativeBorderHint")}</p>
              ) : null}
              <p className="mt-1">{t("streams.nativeParticipantNote")}</p>
            </div>
          ) : null}

          <label className="flex items-center justify-between gap-3">
            <span className="min-w-0">
              <span className="block text-[12px] text-muted">
                {coreAudio === "no"
                  ? t("streams.systemAudio")
                  : t("streams.computerAudio")}
              </span>
              <span
                data-testid="stream-audio-hint"
                className={cn(
                  "block text-[11px]",
                  coreAudio === "no" && isDesktop && audio
                    ? "text-warning"
                    : "text-faint",
                )}
              >
                {coreAudio === "checking"
                  ? t("streams.computerAudioChecking")
                  : coreAudio === "yes"
                    ? t("streams.computerAudioHint")
                    : isDesktop
                      ? t("streams.systemAudioFallback")
                      : t("streams.systemAudioHint")}
              </span>
            </span>
            <Switch
              checked={audio}
              onCheckedChange={setAudio}
              aria-label={
                coreAudio === "no"
                  ? t("streams.systemAudio")
                  : t("streams.computerAudio")
              }
            />
          </label>
        </div>

        {!canStream ? (
          <p
            role="alert"
            className="mt-3 rounded-sm border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-[12px] text-danger"
          >
            {t("streams.noPermission")}
          </p>
        ) : error ? (
          <div
            role="alert"
            data-testid="stream-error"
            className={cn(
              "mt-3 rounded-sm border px-2.5 py-1.5 text-[12px]",
              error.code === "captureBorder"
                ? "border-warning/40 bg-warning/10 text-warning"
                : "border-warning/40 bg-warning/10 text-warning",
            )}
          >
            <p>
              {error.code === "noSource"
                ? t("streams.noSource")
                : error.code === "permissionDenied"
                  ? t("streams.noPermission")
                  : error.code === "captureCancelled"
                    ? t("streams.nativeCancelled")
                    : error.code === "captureBorder"
                      ? t("streams.nativeBorderNotice")
                      : error.code === "nativeSourceClosed"
                        ? t("streams.nativeSourceClosed")
                        : error.code === "nativeEnded"
                          ? t("streams.nativeEnded")
                          : error.code === "nativeCursor"
                            ? t("streams.nativeCursorFailed")
                            : t("streams.startFailed", { message: error.message })}
            </p>
            {native && nativeCancelled ? (
              <Button
                className="mt-2"
                size="xs"
                variant="secondary"
                onClick={() => {
                  // The fallback is deliberate: WebView2 keeps the visible
                  // system cursor. Cancelling the native picker never starts
                  // it by itself.
                  setNative(false);
                  void submit(false);
                }}
                data-testid="stream-webview-fallback"
              >
                {t("streams.useWebviewFallback")}
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={busy || !canStream || (native && nativeProtected && !streaming)}
            data-testid="stream-start"
          >
            <MonitorUp className="size-3.5" aria-hidden />
            {nativeStatus === "picking"
              ? t("streams.nativePicking")
              : t("streams.start")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
