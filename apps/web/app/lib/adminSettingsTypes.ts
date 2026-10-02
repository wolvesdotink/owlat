/**
 * The shapes of the admin settings table (`adminSettingsRegistry.ts`): the
 * environment a gate reads, the rail's areas and one entry. Split out of the
 * registry to keep it under the file-size ratchet; the registry re-exports
 * everything here, so callers keep importing from it.
 */
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';

/**
 * The ambient inputs an admin gate reads. Role is deliberately absent: the whole
 * tree already sits behind the `admin` route middleware, so a gate here answers
 * "does this deployment have this page" rather than "may this person open it".
 */
export interface AdminEnvironment {
	isFeatureEnabled(flag: FeatureFlagKey): boolean;
	/** Deployment-level tooling (operator console, system, backups). */
	isPlatformAdmin: boolean;
	/** This build ships at least one plugin that has settings. */
	hasPlugins: boolean;
	/** The delivery ramp has taken over a cell (now, or within decision retention). */
	hasRampStarted: boolean;
}

export type AdminGate = (env: AdminEnvironment) => boolean;

/** The groups the rail renders as eyebrows, in this order. */
export type AdminAreaKey = 'overview' | 'team' | 'delivery' | 'ai' | 'features' | 'system';

export const ADMIN_AREAS: readonly {
	readonly key: AdminAreaKey;
	readonly titleKey: string;
}[] = [
	{ key: 'overview', titleKey: 'shell.admin.areas.overview' },
	{ key: 'team', titleKey: 'shell.admin.areas.team' },
	{ key: 'delivery', titleKey: 'shell.admin.areas.delivery' },
	{ key: 'ai', titleKey: 'shell.admin.areas.ai' },
	{ key: 'features', titleKey: 'shell.admin.areas.features' },
	{ key: 'system', titleKey: 'shell.admin.areas.system' },
];

/**
 * A live count that earns a rail entry an attention badge. The layout resolves
 * it (it owns the Convex read); the registry only says which count it is.
 */
export type AdminAttentionKey = 'quarantined' | 'failed';

/** One Workspace settings destination. */
export interface AdminEntry {
	readonly id: string;
	readonly path: string;
	/**
	 * i18n KEY for the label — used by the rail, the crumb and the palette alike,
	 * so the three print one string. Module scope cannot call `useI18n`, so every
	 * consumer resolves it at its own render boundary.
	 */
	readonly titleKey: string;
	readonly icon: string;
	readonly area: AdminAreaKey;
	readonly gate?: AdminGate;
	/**
	 * Reachable, crumbed and searchable, but not listed in the rail — the rail
	 * shows its `parent` instead, and marks the parent current while you are here.
	 */
	readonly hidden?: boolean;
	/** Id of the rail entry that stands for this page. Only set on hidden entries. */
	readonly parent?: string;
	/**
	 * The page's hidden children render as tabs above it (the "Advanced" group of
	 * ramp pages is one rail entry with four tabs, not four rail entries).
	 */
	readonly tabs?: boolean;
	/**
	 * Tables and side-by-side layouts that need room (domains, cells, the
	 * channel list with its overview, the email theme beside its preview) opt
	 * out of the settings shell's reading width.
	 */
	readonly wide?: boolean;
	/** Badge this entry with a live count when it is non-zero. */
	readonly attention?: AdminAttentionKey;
}
