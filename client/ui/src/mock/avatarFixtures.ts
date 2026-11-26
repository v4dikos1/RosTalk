import { fixtureState } from "./fixtures";

/**
 * Avatar simulation for the fixture adapter (stage P11).
 *
 * The gallery and Playwright have no server. Two browser pages act as two
 * clients: an upload stores the picture and broadcasts the new content hash
 * over `BroadcastChannel`, and every other page applies it as the same
 * `userUpdated` delta the real core receives. The bytes live in
 * `localStorage`, so a second page can render the picture too.
 */

const STORAGE_KEY = "rostalk.fixture.avatars.v1";
const CHANNEL_NAME = "rostalk.fixture.avatars";

/**
 * A tiny demo picture for the gallery and Playwright. The URL host is the
 * fixture adapter, not a real server, so this is only ever used in a browser
 * preview. `?demoAvatarUser=2` seeds a stored avatar for that user;
 * `?demoAvatarUnavailable=1` keeps only the hash, which exercises the
 * "picture failed" state without inventing a second code path.
 */
const DEMO_AVATAR_HASH = "c".repeat(64);
const DEMO_AVATAR =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#5b8def"/><stop offset="1" stop-color="#8f6bd8"/>' +
      "</linearGradient></defs>" +
      '<rect width="256" height="256" fill="url(#g)"/>' +
      '<circle cx="128" cy="102" r="38" fill="#ffffff" fill-opacity=".9"/>' +
      '<rect x="64" y="154" width="128" height="64" rx="32" fill="#ffffff" fill-opacity=".9"/>' +
      "</svg>",
  );

function applyDemoAvatar(): void {
  if (typeof window === "undefined") {
    return;
  }
  const params = new URLSearchParams(window.location.search);
  const id = Number(params.get("demoAvatarUser"));
  if (!Number.isInteger(id) || id <= 0) {
    return;
  }
  const user = fixtureState.users.find((item) => item.id === id);
  if (!user) {
    return;
  }
  user.avatarHash = DEMO_AVATAR_HASH;
  if (!params.has("demoAvatarUnavailable")) {
    const store = readStore();
    store[DEMO_AVATAR_HASH] = DEMO_AVATAR;
    writeStore(store);
  }
}

export interface FixtureAvatarChange {
  userId: number;
  hash: string;
}

const listeners = new Set<(change: FixtureAvatarChange) => void>();
const channel =
  typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel(CHANNEL_NAME)
    : null;

type Store = Record<string, string>;

function readStore(): Store {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // A full or disabled storage only costs a picture in the preview.
  }
}

/** Data URL of a fixture avatar, empty when the hash is unknown. */
export function fixtureAvatarUrl(hash: string): string {
  if (!hash) {
    return "";
  }
  return readStore()[hash] ?? "";
}

function notify(change: FixtureAvatarChange): void {
  const user = fixtureState.users.find((item) => item.id === change.userId);
  if (user) {
    user.avatarHash = change.hash;
  }
  for (const listener of listeners) {
    listener(change);
  }
}

channel?.addEventListener("message", (event: MessageEvent<FixtureAvatarChange>) => {
  const change = event.data;
  if (change && typeof change.userId === "number" && typeof change.hash === "string") {
    notify(change);
  }
});

export function subscribeFixtureAvatars(
  listener: (change: FixtureAvatarChange) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function hashPicture(picture: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await picture.arrayBuffer());
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function readAsDataUrl(picture: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("fixture avatar read failed"));
    reader.readAsDataURL(picture);
  });
}

/** Mimics `PUT /avatars/me`: stores the picture and announces the hash. */
export async function fixtureUploadAvatar(picture: Blob): Promise<string> {
  const [hash, dataUrl] = await Promise.all([
    hashPicture(picture),
    readAsDataUrl(picture),
  ]);
  const store = readStore();
  store[hash] = dataUrl;
  writeStore(store);
  const change = { userId: fixtureState.selfUserId, hash };
  notify(change);
  channel?.postMessage(change);
  return hash;
}

/** Mimics `DELETE /avatars/me`; only the fixture user's own picture. */
export function fixtureClearAvatar(): void {
  const change = { userId: fixtureState.selfUserId, hash: "" };
  notify(change);
  channel?.postMessage(change);
}

applyDemoAvatar();
