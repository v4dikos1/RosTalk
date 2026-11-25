import type { ChatProxyView } from "@/core/api";
import {
  fixtureAvatarUrl,
  fixtureClearAvatar,
  fixtureUploadAvatar,
} from "@/mock/avatarFixtures";

/**
 * Client side of the avatar endpoints (stage P11).
 *
 * The picture goes through the core's loopback proxy like chat: the page never
 * opens a TLS connection to the server and never sees the server session
 * token. The URL of a picture carries the proxy token in `?pt=`, because an
 * `<img>` cannot set a header (ADR 0022, ADR 0032).
 */

/** The server accepts at most 4 MiB before decoding. */
export const MAX_AVATAR_BYTES = 4 * 1024 * 1024;
/** Side of the square the server stores and the canvas produces. */
export const AVATAR_SIZE = 256;

export function isFixtureProxy(proxy: ChatProxyView): boolean {
  return proxy.baseUrl.startsWith("fixture://");
}

/** URL of one avatar, cached forever by its content hash. */
export function avatarUrl(proxy: ChatProxyView, hash: string): string {
  if (!hash) {
    return "";
  }
  if (isFixtureProxy(proxy)) {
    return fixtureAvatarUrl(hash);
  }
  return `${proxy.baseUrl}/avatars/${hash}?pt=${encodeURIComponent(proxy.token)}`;
}

/** Error returned by an avatar endpoint. Never contains a token. */
export class AvatarHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AvatarHttpError";
    this.status = status;
    this.code = code;
  }
}

async function proxyError(response: Response): Promise<AvatarHttpError> {
  let code = "request_failed";
  try {
    const body = (await response.json()) as { error?: { code?: string } };
    code = body.error?.code ?? code;
  } catch {
    // Keep the generic code.
  }
  return new AvatarHttpError(response.status, code, "avatar request failed");
}

/** Localised `avatar.errors.*` key for a failed avatar call. */
export function avatarErrorKey(error: unknown): string {
  if (error instanceof AvatarHttpError) {
    if (error.code === "file_too_large" || error.status === 413) {
      return "avatar.errors.tooLarge";
    }
    if (error.code === "unsupported_type" || error.status === 415) {
      return "avatar.errors.unsupported";
    }
    if (error.code === "invalid_image" || error.status === 400) {
      return "avatar.errors.invalid";
    }
    if (error.code === "rate_limited" || error.status === 429) {
      return "avatar.errors.rate";
    }
    if (error.status === 0 || error.status >= 500) {
      return "avatar.errors.network";
    }
    if (error.status === 403) {
      return "avatar.errors.denied";
    }
  }
  return "avatar.errors.failed";
}

/** Uploads a square PNG produced by the crop dialog. */
export async function uploadAvatar(
  proxy: ChatProxyView,
  picture: Blob,
): Promise<string> {
  if (isFixtureProxy(proxy)) {
    return fixtureUploadAvatar(picture);
  }
  if (picture.size > MAX_AVATAR_BYTES) {
    throw new AvatarHttpError(413, "file_too_large", "the picture is too large");
  }
  const response = await fetch(`${proxy.baseUrl}/avatars/me`, {
    method: "PUT",
    headers: {
      "X-RosTalk-Proxy-Token": proxy.token,
      "Content-Type": "image/png",
    },
    body: picture,
  });
  if (!response.ok) {
    throw await proxyError(response);
  }
  const body = (await response.json()) as { avatarHash?: string };
  if (!body.avatarHash) {
    throw new AvatarHttpError(response.status, "invalid_response", "no avatar hash");
  }
  return body.avatarHash;
}

/** Removes the caller's picture. */
export async function removeAvatar(proxy: ChatProxyView): Promise<void> {
  if (isFixtureProxy(proxy)) {
    fixtureClearAvatar();
    return;
  }
  const response = await fetch(`${proxy.baseUrl}/avatars/me`, {
    method: "DELETE",
    headers: { "X-RosTalk-Proxy-Token": proxy.token },
  });
  if (!response.ok) {
    throw await proxyError(response);
  }
}

/** Administrator action: removes another user's picture. */
export async function resetUserAvatar(
  proxy: ChatProxyView,
  userId: number,
): Promise<void> {
  if (isFixtureProxy(proxy)) {
    fixtureClearAvatar(userId);
    return;
  }
  const response = await fetch(`${proxy.baseUrl}/members/${userId}/avatar`, {
    method: "DELETE",
    headers: { "X-RosTalk-Proxy-Token": proxy.token },
  });
  if (!response.ok) {
    throw await proxyError(response);
  }
}

// ------------------------------------------------------------ crop maths ---

export interface AvatarCrop {
  /** Left edge in source pixels. */
  sx: number;
  /** Top edge in source pixels. */
  sy: number;
  /** Side of the square in source pixels. */
  size: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Source square currently visible in the crop viewport.
 *
 * `zoom` 1 means "the picture covers the square" (the shorter side fills it),
 * larger values zoom in. `offsetX`/`offsetY` are the pan in view pixels; they
 * are clamped so the square never shows an empty edge.
 */
export function avatarCrop(
  width: number,
  height: number,
  view: number,
  zoom: number,
  offsetX: number,
  offsetY: number,
): AvatarCrop {
  if (width <= 0 || height <= 0 || view <= 0) {
    return { sx: 0, sy: 0, size: 0 };
  }
  const safeZoom = clamp(zoom, 1, 4);
  const scale = (view / Math.min(width, height)) * safeZoom;
  const shownWidth = width * scale;
  const shownHeight = height * scale;
  const maxX = Math.max(0, (shownWidth - view) / 2);
  const maxY = Math.max(0, (shownHeight - view) / 2);
  const panX = clamp(offsetX, -maxX, maxX);
  const panY = clamp(offsetY, -maxY, maxY);
  const size = Math.min(width, height) / safeZoom;
  const sx = clamp(width / 2 - size / 2 - panX / scale, 0, width - size);
  const sy = clamp(height / 2 - size / 2 - panY / scale, 0, height - size);
  return { sx, sy, size };
}

/** Largest allowed pan for one axis, in view pixels. */
export function avatarMaxOffset(
  width: number,
  height: number,
  view: number,
  zoom: number,
): { x: number; y: number } {
  if (width <= 0 || height <= 0 || view <= 0) {
    return { x: 0, y: 0 };
  }
  const safeZoom = clamp(zoom, 1, 4);
  const scale = (view / Math.min(width, height)) * safeZoom;
  return {
    x: Math.max(0, (width * scale - view) / 2),
    y: Math.max(0, (height * scale - view) / 2),
  };
}

/** Draws the visible square into a 256x256 canvas. */
export function drawAvatarCrop(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource & { width: number; height: number },
  view: number,
  zoom: number,
  offsetX: number,
  offsetY: number,
): void {
  const crop = avatarCrop(image.width, image.height, view, zoom, offsetX, offsetY);
  context.clearRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
  context.drawImage(
    image,
    crop.sx,
    crop.sy,
    crop.size,
    crop.size,
    0,
    0,
    AVATAR_SIZE,
    AVATAR_SIZE,
  );
}

/** Encodes a canvas as the PNG the endpoint expects. */
export function canvasToAvatar(
  canvas: HTMLCanvasElement,
  type = "image/png",
  quality = 0.92,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new AvatarHttpError(0, "encode_failed", "could not encode the picture"));
        }
      },
      type,
      quality,
    );
  });
}
