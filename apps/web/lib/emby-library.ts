import type { LibraryCategory } from "@media-track/workflow";
import { listEmbyLibraryItems, type EmbyLibraryItem } from "./emby-client";
import { resolveAccountEmbyConfig } from "./workflow-runtime";

/** Emby library reads are cached briefly: the poster wall renders on every home
 *  load, and Emby should not be hit four times per navigation. */
const TTL_MS = 5 * 60_000;
const CATEGORIES = ["movies", "tv", "variety", "anime"] as const;

export type EmbyLibrarySnapshot = Array<{ category: LibraryCategory; items: EmbyLibraryItem[] }>;

interface CacheEntry {
  expiresAt: number;
  items: EmbyLibraryItem[];
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<EmbyLibraryItem[]>>();

export async function listEmbyLibrariesForAccount(
  accountId: string,
): Promise<EmbyLibrarySnapshot> {
  const config = await resolveAccountEmbyConfig(accountId);
  if (!config) return [];
  return Promise.all(
    CATEGORIES.map(async (category) => {
      const key = `${accountId}:${category}`;
      const hit = cache.get(key);
      if (hit && hit.expiresAt > Date.now()) {
        return { category, items: hit.items };
      }
      const pending = inFlight.get(key);
      if (pending) return { category, items: await pending };
      const promise = listEmbyLibraryItems(config, category)
        .then((items) => {
          cache.set(key, { expiresAt: Date.now() + TTL_MS, items });
          return items;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, promise);
      return { category, items: await promise };
    }),
  );
}

/** Settings changed the Emby URL/key/library names. */
export function clearEmbyLibraryCache(accountId?: string): void {
  if (!accountId) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${accountId}:`)) cache.delete(key);
  }
}
