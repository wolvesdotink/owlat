/**
 * The rows of the shortcuts page: every catalog entry this instance can fire,
 * grouped by the scope that answers it, with the state a row shows (its live
 * chords, fixed or remappable, changed by the person, clashing with another).
 *
 * Pure, so the visibility matrix and the filter are unit-tested without
 * mounting the page. Visibility follows the features: a member of an instance
 * without personal mail is not shown the Postbox's forty keys, and the desktop
 * workspace switcher only appears in the desktop app.
 */

import type {
	ShortcutBindings,
	ShortcutConflict,
	ShortcutDefinition,
	ShortcutScope,
} from './shortcutRegistry';
import type { SettingsEnvironment } from '~/lib/settingsRegistry';

/** The order the page lists the scopes in, app-wide first. */
export const SHORTCUT_SCOPE_ORDER: readonly ShortcutScope[] = [
	'global',
	'postbox',
	'composer',
	'chatComposer',
	'inbox',
	'inboxList',
	'review',
	'workbench',
	'peek',
	'answer',
	'answerQueue',
	'askCard',
	'mailCard',
	'teamCard',
	'mentionCard',
	'workspace',
];

const hasMail = (env: SettingsEnvironment) =>
	env.isFeatureEnabled('postbox') || env.isFeatureEnabled('mail.external');

/** Whether a scope's surface exists on this instance, in this runtime. */
export function isShortcutScopeAvailable(scope: ShortcutScope, env: SettingsEnvironment): boolean {
	switch (scope) {
		case 'postbox':
			return hasMail(env);
		case 'composer':
		case 'answer':
		case 'askCard':
			return hasMail(env) || env.isFeatureEnabled('inbox');
		// The Answer queue gathers mail, Team inbox drafts and chat mentions.
		case 'answerQueue':
			return hasMail(env) || env.isFeatureEnabled('inbox') || env.isFeatureEnabled('chat');
		case 'mailCard':
			return hasMail(env);
		case 'inbox':
		case 'inboxList':
		case 'review':
		case 'teamCard':
			return env.isFeatureEnabled('inbox');
		case 'mentionCard':
			return env.isFeatureEnabled('chat');
		case 'chatComposer':
			return env.isFeatureEnabled('chat') || env.isFeatureEnabled('ai.assistant');
		case 'workspace':
			return env.isDesktop;
		default:
			return true;
	}
}

/** Entries whose own feature can be off while their scope is on. */
const ENTRY_GATES: Readonly<Record<string, (env: SettingsEnvironment) => boolean>> = {
	'global.assistant': (env) => env.isFeatureEnabled('ai.assistant'),
	'global.ask': (env) => env.isFeatureEnabled('ai.knowledge'),
	// Only the Assistant steps forward through its questions; Chat has no ↓.
	'chatComposer.recallNewer': (env) => env.isFeatureEnabled('ai.assistant'),
};

/**
 * Whether a catalog entry can fire on this instance at all — the page and the
 * app-wide "?" sheet both leave the rest out, so neither promises a key that
 * does nothing (⌘J with the Assistant switched off).
 */
export function isShortcutEntryAvailable(
	def: Pick<ShortcutDefinition, 'id' | 'scope'>,
	env: SettingsEnvironment
): boolean {
	if (!isShortcutScopeAvailable(def.scope, env)) return false;
	return ENTRY_GATES[def.id]?.(env) ?? true;
}

export interface ShortcutSettingsRow {
	def: ShortcutDefinition;
	/** The chords that fire it right now (preset + the person's remaps). */
	chords: readonly string[];
	fixed: boolean;
	/** The person stored a remap for it (the row offers Reset). */
	overridden: boolean;
	/** The other ids it currently clashes with inside its scope. */
	clashesWith: readonly string[];
}

export interface ShortcutSettingsSection {
	scope: ShortcutScope;
	rows: ShortcutSettingsRow[];
}

/** The ids each id currently clashes with, from the live conflict list. */
export function clashesById(conflicts: readonly ShortcutConflict[]): Map<string, string[]> {
	const byId = new Map<string, string[]>();
	for (const conflict of conflicts) {
		for (const id of conflict.ids) {
			const others = conflict.ids.filter((other) => other !== id);
			byId.set(id, [...new Set([...(byId.get(id) ?? []), ...others])]);
		}
	}
	return byId;
}

/**
 * True when every word of `query` appears in one of `haystack`'s strings,
 * ignoring case: "go draft" finds "Go to drafts", "ctrl" finds every
 * Ctrl chord. An empty query matches everything.
 */
export function matchesShortcutFilter(haystack: readonly string[], query: string): boolean {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return true;
	const text = haystack.map((part) => part.toLowerCase());
	return words.every((word) => text.some((part) => part.includes(word)));
}

export function shortcutSettingsSections(
	definitions: readonly ShortcutDefinition[],
	bindings: ShortcutBindings,
	opts: {
		env: SettingsEnvironment;
		overridden: ReadonlySet<string>;
		/** The words a row is found by: its label, scope and chords as shown. */
		describe: (def: ShortcutDefinition, chords: readonly string[]) => readonly string[];
		query: string;
	}
): ShortcutSettingsSection[] {
	const clashes = clashesById(bindings.conflicts);
	const sections: ShortcutSettingsSection[] = [];
	for (const scope of SHORTCUT_SCOPE_ORDER) {
		if (!isShortcutScopeAvailable(scope, opts.env)) continue;
		const rows: ShortcutSettingsRow[] = [];
		for (const def of definitions) {
			if (def.scope !== scope || !isShortcutEntryAvailable(def, opts.env)) continue;
			const chords = bindings.byId.get(def.id) ?? [];
			if (!matchesShortcutFilter(opts.describe(def, chords), opts.query)) continue;
			rows.push({
				def,
				chords,
				fixed: def.remappable === false,
				overridden: opts.overridden.has(def.id),
				clashesWith: clashes.get(def.id) ?? [],
			});
		}
		if (rows.length > 0) sections.push({ scope, rows });
	}
	return sections;
}
