/**
 * THE settings table: every Preferences destination, the section it belongs to,
 * the gate it is registered behind, and the individual controls that live on it.
 *
 * Settings destinations used to be declared in four hand-maintained places — the
 * sidebar table (`dashboardNavigationCore.ts`), the breadcrumb table
 * (`breadcrumbRoutes.ts`), the hub's link grid (`PreferencesMailLinks.vue`) and
 * each page's own back link — and they had already drifted apart: aliases,
 * vacation, snippets, writing voice and app passwords existed as pages but were
 * missing from the sidebar table, so ⌘K could not find them, and the hub's grid
 * was rendered behind `v-if="hasMail"`, which left them with no entry point at
 * all on an instance without mail. This module is the single declaration all of
 * those surfaces now read.
 *
 * Every entry also declares its CONTROLS — the individual switches a person
 * actually looks for ("dark mode", "auto-advance", "notify me about") — each
 * with an `anchor` on its own page, so the command palette can index controls
 * and not just destinations and deep-link into the section that holds one.
 *
 * Pure data plus pure predicates (no Vue, no Nuxt, no Convex), so the whole
 * flag/desktop matrix is unit-testable — see `__tests__/settingsRegistry.test.ts`.
 * Titles, descriptions and keywords are i18n KEYS: module scope cannot call
 * `useI18n`, so every consumer resolves them at its own render boundary.
 */
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import { fuzzyMatch } from './commandPalette';

/** Where the Preferences tree lives. Everything under it is registry-owned. */
export const SETTINGS_ROOT = '/dashboard/preferences';

/**
 * The ambient inputs a gate reads. Deliberately a subset of
 * `NavigationEnvironment` (no role — no personal preference is role-gated), so a
 * `SettingsGate` is assignable wherever a navigation gate is expected.
 */
export interface SettingsEnvironment {
	isFeatureEnabled(flag: FeatureFlagKey): boolean;
	isDesktop: boolean;
}

export type SettingsGate = (env: SettingsEnvironment) => boolean;

const flag =
	(key: FeatureFlagKey): SettingsGate =>
	(env) =>
		env.isFeatureEnabled(key);
/** Mail exists on this instance at all (hosted postbox or a connected mailbox). */
export const hasMail: SettingsGate = (env) =>
	env.isFeatureEnabled('postbox') || env.isFeatureEnabled('mail.external');
const desktopOnly: SettingsGate = (env) => env.isDesktop;
const all =
	(...gates: readonly SettingsGate[]): SettingsGate =>
	(env) =>
		gates.every((gate) => gate(env));
const any =
	(...gates: readonly SettingsGate[]): SettingsGate =>
	(env) =>
		gates.some((gate) => gate(env));

/** The four groups the hub, the left nav and the palette subtitle share. */
export type SettingsSectionKey = 'general' | 'mail' | 'account' | 'device';

export const SETTINGS_SECTIONS: readonly {
	readonly key: SettingsSectionKey;
	readonly titleKey: string;
}[] = [
	{ key: 'general', titleKey: 'shared.settingsRegistry.sections.general' },
	{ key: 'mail', titleKey: 'shared.settingsRegistry.sections.mail' },
	{ key: 'account', titleKey: 'shared.settingsRegistry.sections.account' },
	{ key: 'device', titleKey: 'shared.settingsRegistry.sections.device' },
];

/**
 * One switch on a settings page. `anchor` is the id of the element that holds
 * it (page-level `id`), so `path#anchor` is a working deep link.
 */
export interface SettingsControl {
	readonly id: string;
	readonly titleKey: string;
	/**
	 * i18n key for a comma-separated list of synonyms someone might type instead
	 * of the title ("dark mode" for Appearance). Search only, never rendered.
	 */
	readonly keywordsKey: string;
	readonly anchor: string;
	readonly gate?: SettingsGate;
}

/** One settings destination. */
export interface SettingsEntry {
	readonly id: string;
	readonly path: string;
	readonly titleKey: string;
	readonly descriptionKey: string;
	readonly icon: string;
	readonly section: SettingsSectionKey;
	readonly keywordsKey: string;
	readonly gate?: SettingsGate;
	/**
	 * Reachable, and breadcrumbed, but not listed in the hub or the left nav —
	 * a wizard you enter from a button rather than a place you browse to.
	 */
	readonly hidden?: boolean;
	readonly controls?: readonly SettingsControl[];
}

const key = (id: string, leaf: string) => `shared.settingsRegistry.entries.${id}.${leaf}`;
const controlKey = (id: string, leaf: string) => `shared.settingsRegistry.controls.${id}.${leaf}`;

function entry(
	id: string,
	rest: Omit<SettingsEntry, 'id' | 'titleKey' | 'descriptionKey' | 'keywordsKey'>
): SettingsEntry {
	return {
		id,
		titleKey: key(id, 'title'),
		descriptionKey: key(id, 'description'),
		keywordsKey: key(id, 'keywords'),
		...rest,
	};
}

function control(id: string, anchor: string, gate?: SettingsGate): SettingsControl {
	return {
		id,
		anchor,
		titleKey: controlKey(id, 'title'),
		keywordsKey: controlKey(id, 'keywords'),
		...(gate ? { gate } : {}),
	};
}

/**
 * The canonical settings table, in the order the hub and the left nav render it.
 * Section grouping is by `section`; ordering within a section is this order.
 */
export const SETTINGS_REGISTRY: readonly SettingsEntry[] = [
	entry('overview', {
		path: SETTINGS_ROOT,
		icon: 'lucide:settings',
		section: 'general',
		controls: [
			control('appearance', 'appearance'),
			control('language', 'language'),
			control('autoAdvance', 'reading', hasMail),
			control('markRead', 'reading', hasMail),
			control('density', 'reading', hasMail),
			control('readingPane', 'reading', hasMail),
			control('replyDefault', 'reading', hasMail),
			control('writingSuggestions', 'reading', all(hasMail, flag('ai'))),
			control('autoSummarize', 'reading', all(hasMail, flag('ai'))),
			control('sendSound', 'reading', hasMail),
			control('dailyBriefEmail', 'daily-brief', hasMail),
			control('sharedLinks', 'shared-links', hasMail),
			control('mailboxes', 'mailboxes', hasMail),
		],
	}),
	entry('filters', {
		path: `${SETTINGS_ROOT}/filters`,
		icon: 'lucide:list-filter',
		section: 'mail',
		gate: hasMail,
	}),
	entry('aliases', {
		path: `${SETTINGS_ROOT}/aliases`,
		icon: 'lucide:at-sign',
		section: 'mail',
		gate: hasMail,
	}),
	entry('forwarding', {
		path: `${SETTINGS_ROOT}/forwarding`,
		icon: 'lucide:forward',
		section: 'mail',
		gate: hasMail,
	}),
	entry('vacation', {
		path: `${SETTINGS_ROOT}/vacation`,
		icon: 'lucide:plane',
		section: 'mail',
		gate: hasMail,
	}),
	entry('signatures', {
		path: `${SETTINGS_ROOT}/signatures`,
		icon: 'lucide:signature',
		section: 'mail',
		gate: hasMail,
	}),
	entry('snippets', {
		path: `${SETTINGS_ROOT}/snippets`,
		icon: 'lucide:text-quote',
		section: 'mail',
		gate: hasMail,
	}),
	entry('writingVoice', {
		path: `${SETTINGS_ROOT}/writing-voice`,
		icon: 'lucide:wand-sparkles',
		section: 'mail',
		gate: all(hasMail, flag('ai')),
	}),
	entry('connectedMailboxes', {
		path: `${SETTINGS_ROOT}/external-account`,
		icon: 'lucide:mail-plus',
		section: 'mail',
		gate: hasMail,
	}),
	entry('addAccount', {
		path: `${SETTINGS_ROOT}/add-account`,
		icon: 'lucide:plus',
		section: 'mail',
		gate: hasMail,
		hidden: true,
	}),
	entry('account', {
		path: `${SETTINGS_ROOT}/account`,
		icon: 'lucide:user-cog',
		section: 'account',
	}),
	entry('security', {
		path: `${SETTINGS_ROOT}/security`,
		icon: 'lucide:shield-check',
		section: 'account',
	}),
	entry('appPasswords', {
		path: `${SETTINGS_ROOT}/app-passwords`,
		icon: 'lucide:key-round',
		section: 'account',
		gate: hasMail,
	}),
	entry('device', {
		path: `${SETTINGS_ROOT}/device`,
		icon: 'lucide:monitor',
		section: 'device',
		// Everything on this page is device-local: the offline read cache (any
		// browser) plus the desktop app's own switches. Each section self-hides,
		// and the page disappears entirely on an instance with neither.
		gate: any(desktopOnly, hasMail),
		controls: [
			control('offlineCache', 'offline', hasMail),
			control('notifyAbout', 'notifications', all(desktopOnly, hasMail)),
			control('quietHours', 'notifications', all(desktopOnly, hasMail)),
			control('hidePreview', 'notifications', all(desktopOnly, hasMail)),
			control('autostart', 'startup', desktopOnly),
			control('startupWorkspace', 'startup', desktopOnly),
			control('unreadBadge', 'notifications', desktopOnly),
			control('updates', 'updates', desktopOnly),
			control('defaultApp', 'default-app', desktopOnly),
			control('workspaces', 'workspaces', desktopOnly),
		],
	}),
];

/** Registry lookup by path. Undefined for a route the registry does not own. */
export function settingsEntryFor(path: string): SettingsEntry | undefined {
	return SETTINGS_REGISTRY.find((candidate) => candidate.path === path);
}

/** The entries this environment may reach, hidden ones included. Pure. */
export function reachableSettingsEntries(env: SettingsEnvironment): SettingsEntry[] {
	return SETTINGS_REGISTRY.filter((candidate) => !candidate.gate || candidate.gate(env));
}

/** The entries the hub and the left nav list (reachable minus hidden). Pure. */
export function visibleSettingsEntries(env: SettingsEnvironment): SettingsEntry[] {
	return reachableSettingsEntries(env).filter((candidate) => !candidate.hidden);
}

export interface SettingsSectionView {
	readonly key: SettingsSectionKey;
	readonly titleKey: string;
	readonly entries: readonly SettingsEntry[];
}

/**
 * The visible entries grouped into their sections, in registry order, with
 * empty sections dropped. What both the hub and the layout's left nav render.
 * Pure.
 */
export function settingsSectionsFor(env: SettingsEnvironment): SettingsSectionView[] {
	const visible = visibleSettingsEntries(env);
	return SETTINGS_SECTIONS.map((section) => ({
		...section,
		entries: visible.filter((candidate) => candidate.section === section.key),
	})).filter((section) => section.entries.length > 0);
}

/** A control, flattened together with the page it lives on. */
export interface SettingsControlTarget {
	/** Stable across renders; also the palette item id. */
	readonly id: string;
	readonly control: SettingsControl;
	readonly entry: SettingsEntry;
	/** `path#anchor` — the deep link that opens the section holding the control. */
	readonly href: string;
}

/**
 * Every control this environment can actually reach, flattened with its page.
 * A control on an unreachable page is unreachable too, so the entry gate is
 * applied first. Pure.
 */
export function settingsControlTargets(env: SettingsEnvironment): SettingsControlTarget[] {
	return reachableSettingsEntries(env).flatMap((owner) =>
		(owner.controls ?? [])
			.filter((candidate) => !candidate.gate || candidate.gate(env))
			.map((candidate) => ({
				id: `${owner.id}:${candidate.id}`,
				control: candidate,
				entry: owner,
				href: `${owner.path}#${candidate.anchor}`,
			}))
	);
}

/**
 * Read a settings deep link's `#anchor` back, but only if some registry control
 * actually declares it.
 *
 * The layout scrolls to whatever the hash names, so an unvalidated hash would
 * let any link on the internet point the page at an arbitrary element id. Only
 * anchors the registry itself declares are honoured; anything else is ignored
 * and the page opens at the top. Pure.
 */
export function settingsAnchorFromHash(hash: string): string | null {
	const anchor = hash.startsWith('#') ? hash.slice(1) : hash;
	if (!anchor) return null;
	const declared = SETTINGS_REGISTRY.some((owner) =>
		(owner.controls ?? []).some((candidate) => candidate.anchor === anchor)
	);
	return declared ? anchor : null;
}

/** Split a resolved keywords message into its individual synonyms. Pure. */
export function parseKeywords(resolved: string): string[] {
	return resolved
		.split(',')
		.map((word) => word.trim())
		.filter((word) => word.length > 0);
}

/** An already-localized search candidate: title, context line, synonyms. */
export interface KeywordSearchable {
	label: string;
	subtitle?: string;
	keywords: readonly string[];
}

/**
 * Fuzzy-filter localized settings rows over label, subtitle AND keywords.
 *
 * `filterItems` (the palette's own) only looks at label and subtitle, so typing
 * "dark" would never surface "Appearance". Ranking is label > subtitle >
 * keyword, then the fuzzy score, then input order — the same shape as
 * `scoreItems`, with the synonym tier appended last so a real title always wins
 * over someone else's synonym. An empty query returns the input unchanged. Pure.
 */
export function filterByKeywords<T extends KeywordSearchable>(items: T[], rawQuery: string): T[] {
	const query = rawQuery.trim();
	if (!query) return [...items];

	const scored: { item: T; rank: number; score: number; index: number }[] = [];
	items.forEach((item, index) => {
		const onLabel = fuzzyMatch(item.label, query);
		if (onLabel) {
			scored.push({ item, rank: 0, score: onLabel.score, index });
			return;
		}
		const onSubtitle = item.subtitle ? fuzzyMatch(item.subtitle, query) : null;
		if (onSubtitle) {
			scored.push({ item, rank: 1, score: onSubtitle.score, index });
			return;
		}
		let best: number | null = null;
		for (const word of item.keywords) {
			const hit = fuzzyMatch(word, query);
			if (hit && (best === null || hit.score > best)) best = hit.score;
		}
		if (best !== null) scored.push({ item, rank: 2, score: best, index });
	});

	return scored
		.sort((a, b) => a.rank - b.rank || b.score - a.score || a.index - b.index)
		.map(({ item }) => item);
}
