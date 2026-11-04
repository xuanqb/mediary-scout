/**
 * Storage brand registry — the per-(account, drive) capabilities the worker and
 * web share, keyed by `connected_storages.provider`. Replaces the old global
 * `MEDIA_TRACK_STORAGE_ADAPTER==="115"` switch: dispatch is now per-drive, so one
 * account can hold a 115 drive and a quark drive side by side (tree model).
 *
 * NOTE: `createExecutor` deliberately does NOT live here — building a protected
 * executor needs env (write-scope CIDs) + the apps/web protected wrapper, which
 * the pure workflow package must not import. apps/web owns the factory
 * (`createExecutorForBrand`); this registry holds only the pure, brand-identity
 * capabilities (uid parsing, auth-error classification, applicable resource kinds).
 */
import { parsePan115Uid } from "./account-credentials.js";
import type { ResourceType } from "./domain.js";
import { isPan115AuthError } from "./pan115-cookie-client.js";
import { isQuarkAuthError, parseQuarkUid } from "./quark-cookie-client.js";

export type StorageProvider = "pan115" | "quark";
export type ResourceProviderKind = "pansou-115" | "pansou-quark" | "pansou-magnet" | "prowlarr";

export interface StorageBrand {
  provider: StorageProvider;
  /** Display name shown in the UI (switcher chip, settings tab). */
  label: string;
  /** Extract the instance-wide-unique account id from the brand's credential —
   *  a cookie string for both cookie brands. Callers pass the brand-appropriate
   *  string, never a JSON blob (a blob would rotate with tokens and destabilize
   *  UNIQUE(provider, provider_uid)). */
  parseUid: (credential: string) => string | null;
  /** Whether an error is this brand's dead-credential signal (drives freeze on it). */
  isAuthError: (err: unknown) => boolean;
  /** Resource providers applicable to this brand. 夸克 has no magnet web API, so
   *  it omits "prowlarr" — magnet is 115 only. */
  resourceProviderKinds: ResourceProviderKind[];
  /** Whether to strengthen the Chinese-subs soft default for this brand. Both
   *  supported drives are Chinese-world drives where resources mostly come from
   *  the Chinese community. */
  assumeChineseSubsFromChineseTitle: boolean;
  /** Credential shape. Both supported brands authenticate with a raw cookie string. */
  authKind: "cookie";
  /** Parent directory id under which connect-time provisioning creates the
   *  category tree — per-brand DATA, not logic. Both 115 & 夸克 root at "0".
   *  Consumed as `provisionCategoryDirs`' baseParentId so the root is
   *  registry-driven instead of hardcoded at each provision call site. */
  provisionRootId: string;
  /** How the brand's executor decides a write is inside the drive's scope.
   *  Both supported brands look the target's parents up on the drive until they
   *  reach a scope root. */
  writeScope: "parents";
}

export const STORAGE_BRANDS: StorageBrand[] = [
  {
    provider: "pan115",
    label: "115 网盘",
    parseUid: parsePan115Uid,
    isAuthError: isPan115AuthError,
    resourceProviderKinds: ["pansou-115", "prowlarr"],
    assumeChineseSubsFromChineseTitle: true,
    authKind: "cookie",
    provisionRootId: "0", // 115 account root
    writeScope: "parents",
  },
  {
    provider: "quark",
    label: "夸克网盘",
    parseUid: parseQuarkUid,
    isAuthError: isQuarkAuthError,
    resourceProviderKinds: ["pansou-quark"],
    assumeChineseSubsFromChineseTitle: true,
    authKind: "cookie",
    provisionRootId: "0", // 夸克 account root
    writeScope: "parents",
  },
];

/**
 * Map a brand's (or multiple brands') resource-provider kinds to the PanSou /
 * Haisou link types its acquisitions may transfer. A 夸克 drive can only save
 * 夸克 share links; 115 takes its OWN share links plus magnets.
 *
 * In unified multi-drive mode, callers pass the UNION of `resourceProviderKinds`
 * across all active connected drives (or call `allowedResourceTypesForProviders`),
 * and this function returns the union of allowed `ResourceType`s without order bias.
 */
export function allowedResourceTypesForKinds(kinds: readonly string[]): ResourceType[] {
  if (kinds.length === 0) {
    return ["115", "magnet"];
  }
  const out = new Set<ResourceType>();
  if (kinds.includes("pansou-115")) {
    out.add("115");
    out.add("magnet");
  }
  if (kinds.includes("pansou-quark")) {
    out.add("quark");
  }
  if (kinds.includes("pansou-magnet") || kinds.includes("prowlarr")) {
    out.add("magnet");
  }
  if (out.size === 0) {
    return ["115", "magnet"];
  }
  return [...out];
}

/**
 * Union of `ResourceProviderKind`s and `ResourceType`s across a list of connected
 * storage providers (e.g. `["pan115", "quark"]`). Falls back to `pan115`
 * when no registered provider is given.
 */
export function allowedResourceTypesForProviders(providers: readonly string[]): {
  kinds: ResourceProviderKind[];
  allowedTypes: ResourceType[];
} {
  const registered = providers.filter(isRegisteredStorageProvider);
  const effectiveProviders = registered.length > 0 ? registered : (["pan115"] as const);
  const kindSet = new Set<ResourceProviderKind>();
  for (const p of effectiveProviders) {
    for (const k of getStorageBrand(p).resourceProviderKinds) {
      kindSet.add(k);
    }
  }
  const kinds = [...kindSet];
  return {
    kinds,
    allowedTypes: allowedResourceTypesForKinds(kinds),
  };
}

export function getStorageBrand(provider: string): StorageBrand {
  const brand = STORAGE_BRANDS.find((b) => b.provider === provider);
  if (!brand) {
    throw new Error(`unknown storage brand: ${provider}`);
  }
  return brand;
}

/** Whether a provider string names a registered brand (used to widen the old
 *  `provider==="pan115"` filters to "any registered brand"). */
export function isRegisteredStorageProvider(provider: string): provider is StorageProvider {
  return STORAGE_BRANDS.some((b) => b.provider === provider);
}

/** Whether the drive's executor writes only where it listed or created in this run
 *  (see StorageBrand.writeScope). Kept as an API for callers; both supported brands
 *  use "parents", so this is always false. */
export function brandWritesOnlyListedDirectories(provider: string | undefined): boolean {
  if (!provider || !isRegisteredStorageProvider(provider)) return false;
  return false;
}

/** Whether a brand can use Prowlarr (磁力/PT) — 115 yes, 夸克 no (no magnet API).
 *  Settings hides the Prowlarr block when no connected drive supports it. Safe on
 *  unknown providers (returns false, never throws). */
export function brandSupportsProwlarr(provider: string): boolean {
  return (
    isRegisteredStorageProvider(provider) &&
    getStorageBrand(provider).resourceProviderKinds.includes("prowlarr")
  );
}

/** Display labels of every registered brand that can use Prowlarr, in registry
 *  order. */
export function brandsSupportingProwlarr(): string[] {
  return STORAGE_BRANDS.filter((brand) => brand.resourceProviderKinds.includes("prowlarr")).map(
    (brand) => brand.label,
  );
}
