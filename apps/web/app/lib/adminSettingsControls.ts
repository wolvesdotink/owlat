/**
 * The Workspace settings CONTROLS the command palette indexes: the individual
 * things an owner or admin types into ⌘K ("dkim", "api key", "webhook secret")
 * rather than the page that holds them.
 *
 * The personal half declares its controls inline in `settingsRegistry.ts`; the
 * admin table is close to the file-size cap, so its controls live here and
 * point at registry entries by id instead of restating their routes. A control
 * is reachable exactly when its page is (`isAdminEntryReachable`, the gate the
 * rail and the route palette already use) AND the person may administer the
 * workspace. `AdminEnvironment` deliberately carries no role, so that second
 * check is an explicit argument here, never implied by the environment.
 *
 * Pure data plus pure predicates (no Vue, no Nuxt, no Convex), like the two
 * registries it joins — see `__tests__/adminSettingsControls.test.ts`.
 */
import {
	adminEntryById,
	isAdminEntryReachable,
	type AdminEntry,
	type AdminEnvironment,
} from './adminSettingsRegistry';

/**
 * One control on a Workspace settings page. `anchor` is the id of the element
 * that holds it on that page, so `path#anchor` is a working deep link.
 */
export interface AdminSettingsControl {
	readonly id: string;
	/** Id of the `ADMIN_REGISTRY` entry whose page holds the control. */
	readonly entryId: string;
	readonly anchor: string;
	readonly titleKey: string;
	/** i18n key for comma-separated search synonyms. Search only, never rendered. */
	readonly keywordsKey: string;
}

const controlKey = (id: string, leaf: string) =>
	`shared.settingsRegistry.adminControls.${id}.${leaf}`;

function control(id: string, entryId: string, anchor: string): AdminSettingsControl {
	return {
		id,
		entryId,
		anchor,
		titleKey: controlKey(id, 'title'),
		keywordsKey: controlKey(id, 'keywords'),
	};
}

/**
 * The indexed admin controls. Each anchor must exist on its page in every state
 * the page can load into (the element may arrive after the page's own query
 * resolves; the layout waits for it).
 */
export const ADMIN_SETTINGS_CONTROLS: readonly AdminSettingsControl[] = [
	control('dkim', 'domains', 'sending-domain-list'),
	control('aiProviderKey', 'aiProvider', 'ai-provider-key'),
	control('autonomy', 'aiReplies', 'ai-reply-mode'),
	control('rampPace', 'rampControls', 'ramp-presets'),
	control('webhookSecret', 'webhooks', 'webhook-signing'),
	control('brandColors', 'brandKit', 'brand-colors'),
];

/** An admin control, flattened together with the page it lives on. */
export interface AdminControlTarget {
	/** Stable across renders; namespaced so it never collides with a personal control. */
	readonly id: string;
	readonly control: AdminSettingsControl;
	readonly entry: AdminEntry;
	/** `path#anchor` — the deep link that opens the section holding the control. */
	readonly href: string;
}

/**
 * Every admin control this person can reach. Nothing at all for someone who
 * may not administer the workspace; otherwise the page's registry gate (and
 * its parent's, for a tab like ramp Controls) decides. Pure.
 */
export function adminControlTargets(
	env: AdminEnvironment,
	canAdminister: boolean
): AdminControlTarget[] {
	if (!canAdminister) return [];
	return ADMIN_SETTINGS_CONTROLS.flatMap((candidate) => {
		const entry = adminEntryById(candidate.entryId);
		if (!entry || !isAdminEntryReachable(entry, env)) return [];
		return [
			{
				id: `admin:${entry.id}:${candidate.id}`,
				control: candidate,
				entry,
				href: `${entry.path}#${candidate.anchor}`,
			},
		];
	});
}

/**
 * Read an admin deep link's `#anchor` back, but only when a control on THIS
 * page declares it. The layout scrolls to and outlines whatever this returns,
 * so an arbitrary hash must not be able to point the page at any element id.
 * Pure.
 */
export function adminAnchorFromHash(path: string, hash: string): string | null {
	const anchor = hash.startsWith('#') ? hash.slice(1) : hash;
	if (!anchor) return null;
	const declared = ADMIN_SETTINGS_CONTROLS.some(
		(candidate) => candidate.anchor === anchor && adminEntryById(candidate.entryId)?.path === path
	);
	return declared ? anchor : null;
}
