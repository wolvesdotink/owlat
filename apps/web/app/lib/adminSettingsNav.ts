/**
 * What the Workspace settings shell renders out of the admin registry: the
 * rail's grouped areas, a parent page's tab strip, the attention badges, the
 * breadcrumb's group lead and the admin palette group. The table itself and
 * its plain lookups live in `adminSettingsRegistry.ts`; everything here is a
 * pure projection of it.
 */
import { type PaletteGroup, type PaletteItem, filterItems } from './commandPalette';
import {
	ADMIN_AREAS,
	ADMIN_REGISTRY,
	adminRailEntryFor,
	passesOwnGate,
	reachableAdminEntries,
	type AdminAreaKey,
	type AdminAttentionKey,
	type AdminEntry,
	type AdminEnvironment,
} from './adminSettingsRegistry';

/**
 * The tab strip for `path`: the hidden children of a `tabs` parent, when the
 * current page is one of them (or the parent itself). Empty otherwise. Pure.
 *
 * Each tab answers to its OWN gate only. A parent gated out of the rail (the
 * ramp's Advanced group before the ramp exists) is still a set of real pages
 * when someone lands on one by URL, and its siblings stay one click away.
 */
export function adminTabsFor(path: string, env: AdminEnvironment): AdminEntry[] {
	const rail = adminRailEntryFor(path);
	if (!rail?.tabs) return [];
	return ADMIN_REGISTRY.filter(
		(candidate) => candidate.parent === rail.id && passesOwnGate(candidate, env)
	);
}

export interface AdminAreaView {
	readonly key: AdminAreaKey;
	readonly titleKey: string;
	readonly entries: readonly AdminEntry[];
}

/**
 * The reachable, listed entries grouped into their areas, in registry order,
 * with empty areas dropped — what the Workspace tab renders. Pure.
 */
export function adminAreasFor(env: AdminEnvironment): AdminAreaView[] {
	const listed = reachableAdminEntries(env).filter((candidate) => !candidate.hidden);
	return ADMIN_AREAS.map((area) => ({
		...area,
		entries: listed.filter((candidate) => candidate.area === area.key),
	})).filter((area) => area.entries.length > 0);
}

/**
 * The first listed entry of an area — where the breadcrumb's group crumb
 * points. Ignores gates on purpose: a crumb describes where a page lives. Pure.
 */
export function adminAreaLead(area: AdminAreaKey): AdminEntry | undefined {
	return ADMIN_REGISTRY.find((candidate) => candidate.area === area && !candidate.hidden);
}

/** The attention count for each entry path that has one and is non-zero. Pure. */
export function adminAttentionBadges(
	entries: readonly AdminEntry[],
	counts: Partial<Record<AdminAttentionKey, number>>
): Record<string, number> {
	const badges: Record<string, number> = {};
	for (const candidate of entries) {
		if (!candidate.attention) continue;
		const count = counts[candidate.attention] ?? 0;
		if (count > 0) badges[candidate.path] = count;
	}
	return badges;
}

// ── Command palette ─────────────────────────────────────────────────────────

/** Stable registry id (and dedup key) of the admin shell's palette provider. */
export const ADMIN_COMMAND_PROVIDER_ID = 'surface:admin';

/** Orders this provider within the EXTERNAL tier; core is always consulted first. */
export const ADMIN_COMMAND_PROVIDER_PRIORITY = 20;

/** Group key of the admin "jump to another admin page" block. */
export const ADMIN_COMMAND_GROUP_KEY = 'admin-nav';

export interface AdminSurfaceDeps {
	/** The entries the current environment can reach, already gated. */
	entries: () => readonly AdminEntry[];
	/** Translator — the composable owns `useI18n`, this module cannot. */
	t: (key: string) => string;
	/** Area title for the muted line under a row, by area key. */
	areaTitleKey: (area: AdminAreaKey) => string;
	onOpen: (entry: AdminEntry) => void;
}

/**
 * The Workspace settings' contextual palette group: every admin destination
 * the deployment has, while you are standing in the admin tree.
 *
 * The core navigation provider caps at eight rows across the whole app, so from
 * inside Workspace settings the sibling pages you actually want are the ones
 * that fall off the end. This group puts them at the top instead, with their
 * group as the context line. Item ids are the registry's own (`admin:<id>`)
 * rather than the core `nav:<href>` ids: sharing those would make the group
 * dedup itself away to nothing wherever core already offers the route. Hidden
 * entries are offered too: they are real pages, just not rail rows. Pure.
 */
export function buildAdminSurfaceGroups(deps: AdminSurfaceDeps, query: string): PaletteGroup[] {
	const items: PaletteItem[] = deps.entries().map((entry) => ({
		id: `admin:${entry.id}`,
		label: deps.t(entry.titleKey),
		subtitle: deps.t(deps.areaTitleKey(entry.area)),
		icon: entry.icon,
		// Shared with the core Go to row for the same page: this group renders
		// above it, so inside Administration this row wins and the other drops.
		href: entry.path,
		run: () => deps.onOpen(entry),
	}));
	return [
		{
			key: ADMIN_COMMAND_GROUP_KEY,
			heading: deps.t('shell.admin.paletteHeading'),
			// Above the core verbs (order 5): where you are is what you are moving
			// around in.
			order: 1,
			cap: 8,
			mode: 'commands',
			items: filterItems(items, query),
		},
	];
}
