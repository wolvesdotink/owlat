import { describe, it, expect, beforeEach } from 'vitest';
import { createTestI18n } from '~/__tests__/i18n';
import {
	buildShortcutBindings,
	buildShortcutSheet,
	chordFromEvent,
	chordSteps,
	formatChord,
	isChordPrefix,
	normalizeChord,
	resolveShortcutId,
	shortcutSheetKeys,
	type ShortcutDefinition,
} from '../shortcutRegistry';
import { SHORTCUT_CATALOG } from '../shortcutCatalog';
import {
	SHORTCUT_PRESETS,
	SHORTCUT_PRESET_IDS,
	isRemappableShortcut,
	resolveShortcutPreset,
	shortcutOverridesToOverlay,
} from '../shortcutPresets';
import {
	activeShortcutScopes,
	applyShortcutPreferences,
	isActiveChordPrefix,
	pushShortcutScope,
	resetShortcutPreferences,
	resetShortcutScopes,
	resolveActiveChord,
	resolveActiveShortcut,
	shortcutBindings,
} from '../shortcutScope';

const defs = (...entries: Partial<ShortcutDefinition>[]): ShortcutDefinition[] =>
	entries.map((entry, index) => ({
		id: `test.${index}`,
		scope: 'global',
		keys: [],
		labelKey: 'x',
		groupKey: 'g',
		...entry,
	}));

describe('chords', () => {
	it('normalizes modifier spelling and order', () => {
		expect(normalizeChord('Cmd+Enter')).toBe('mod+Enter');
		expect(normalizeChord('Ctrl+Enter')).toBe('mod+Enter');
		expect(normalizeChord('shift+mod+Enter')).toBe('mod+shift+Enter');
		expect(normalizeChord('g i')).toBe('g i');
	});

	it('keeps single-character keys case-sensitive (Shift lives in the character)', () => {
		expect(normalizeChord('U')).toBe('U');
		expect(normalizeChord('u')).toBe('u');
		expect(normalizeChord('U')).not.toBe(normalizeChord('u'));
	});

	it('rejects a chord it cannot parse rather than inventing one', () => {
		expect(normalizeChord('')).toBeNull();
		expect(normalizeChord('hyper+x')).toBeNull();
		expect(normalizeChord('mod+')).toBeNull();
		// A lone '+' IS a key, not an empty modifier list.
		expect(normalizeChord('+')).toBe('+');
	});

	it('writes the space bar as Space, because " " separates a sequence', () => {
		expect(normalizeChord(' ')).toBe('Space');
		expect(chordFromEvent({ key: ' ' })).toBe('Space');
		expect(chordSteps('g i')).toEqual(['g', 'i']);
	});

	it('builds the same chord from a Cmd event and a Ctrl event', () => {
		expect(chordFromEvent({ key: 'Enter', metaKey: true })).toBe('mod+Enter');
		expect(chordFromEvent({ key: 'Enter', ctrlKey: true })).toBe('mod+Enter');
	});

	it('names Shift only for keys that do not already carry it', () => {
		// Shift+u arrives as 'U' — naming Shift too would make one press two chords.
		expect(chordFromEvent({ key: 'U', shiftKey: true })).toBe('U');
		expect(chordFromEvent({ key: 'Enter', shiftKey: true, metaKey: true })).toBe('mod+shift+Enter');
	});

	it('formats chords per platform', () => {
		expect(formatChord('mod+Enter', true)).toEqual(['⌘', 'Enter']);
		expect(formatChord('mod+Enter', false)).toEqual(['Ctrl', 'Enter']);
		expect(formatChord('g i', false)).toEqual(['g', 'i']);
		expect(formatChord('ArrowDown', false)).toEqual(['↓']);
		expect(formatChord('Escape', false)).toEqual(['Esc']);
	});
});

describe('buildShortcutBindings', () => {
	it('applies overlays in order, each REPLACING the chords before it', () => {
		const catalog = defs({ id: 'a', keys: ['e'] });
		const bindings = buildShortcutBindings(catalog, [{ a: ['q'] }, { a: ['w'] }]);
		expect(bindings.byId.get('a')).toEqual(['w']);
	});

	it('lets an overlay UNBIND a shortcut, which is how a preset frees a key', () => {
		const catalog = defs({ id: 'a', keys: ['b'] }, { id: 'b', keys: ['h'] });
		const bindings = buildShortcutBindings(catalog, [{ a: [], b: ['b'] }]);
		expect(bindings.byId.get('a')).toEqual([]);
		expect(resolveShortcutId(bindings, 'b', ['global'])).toBe('b');
	});

	it('reports a collision inside one scope instead of throwing', () => {
		const catalog = defs({ id: 'a', keys: ['e'] }, { id: 'b', keys: ['e'] });
		const bindings = buildShortcutBindings(catalog);
		expect(bindings.conflicts).toEqual([{ scope: 'global', chord: 'e', ids: ['a', 'b'] }]);
		// First writer keeps the key: one broken remap must not take the rest of
		// the keyboard down with it.
		expect(resolveShortcutId(bindings, 'e', ['global'])).toBe('a');
	});

	it('does not call the same chord in two DIFFERENT scopes a conflict', () => {
		const catalog = defs(
			{ id: 'a', keys: ['?'], scope: 'global' },
			{ id: 'b', keys: ['?'], scope: 'postbox' }
		);
		expect(buildShortcutBindings(catalog).conflicts).toEqual([]);
	});

	it('drops a chord it cannot parse rather than storing an unmatchable one', () => {
		const bindings = buildShortcutBindings(defs({ id: 'a', keys: ['hyper+x', 'e'] }));
		expect(bindings.byId.get('a')).toEqual(['e']);
	});
});

describe('scope resolution', () => {
	const catalog = defs(
		{ id: 'global.admin', keys: ['g s'], scope: 'global' },
		{ id: 'postbox.starred', keys: ['g s'], scope: 'postbox' }
	);
	const bindings = buildShortcutBindings(catalog);

	it('gives the chord to the innermost scope that claims it', () => {
		expect(resolveShortcutId(bindings, 'g s', ['postbox', 'global'])).toBe('postbox.starred');
		expect(resolveShortcutId(bindings, 'g s', ['global'])).toBe('global.admin');
	});

	it('knows a step that begins a longer chord', () => {
		expect(isChordPrefix(bindings, 'g', ['global'])).toBe(true);
		expect(isChordPrefix(bindings, 's', ['global'])).toBe(false);
	});
});

describe('buildShortcutSheet', () => {
	const catalog = defs(
		{ id: 'global.admin', keys: ['g s'], scope: 'global', labelKey: 'admin', groupKey: 'nav' },
		{ id: 'postbox.star', keys: ['g s'], scope: 'postbox', labelKey: 'star', groupKey: 'nav' },
		{ id: 'global.gone', keys: [], scope: 'global', labelKey: 'gone', groupKey: 'nav' },
		{
			id: 'postbox.next',
			keys: ['j', 'ArrowDown'],
			scope: 'postbox',
			labelKey: 'next',
			groupKey: 'move',
		}
	);

	it('omits a global entry whose chord a nearer scope has taken over', () => {
		const bindings = buildShortcutBindings(catalog);
		const ids = buildShortcutSheet(catalog, bindings, { scopes: ['postbox', 'global'] })
			.flatMap((group) => group.items)
			.map((item) => item.id);
		expect(ids).toContain('postbox.star');
		expect(ids).not.toContain('global.admin');
	});

	it('omits documented-but-unbound entries and keeps catalog group order', () => {
		const bindings = buildShortcutBindings(catalog);
		const sheet = buildShortcutSheet(catalog, bindings, { scopes: ['postbox', 'global'] });
		expect(sheet.map((group) => group.groupKey)).toEqual(['nav', 'move']);
		expect(sheet.flatMap((g) => g.items).map((i) => i.id)).not.toContain('global.gone');
	});

	it('prints the canonical chord plus one alternate', () => {
		const bindings = buildShortcutBindings(catalog);
		const sheet = buildShortcutSheet(catalog, bindings, { scopes: ['postbox'] });
		const next = sheet.flatMap((g) => g.items).find((item) => item.id === 'postbox.next');
		expect(shortcutSheetKeys(next!)).toEqual(['j', '↓']);
	});

	it('honours a display override for entries better summarized than listed', () => {
		const sheet = buildShortcutSheet(
			defs({ id: 'a', keys: ['1', '2', '3'], displayKeys: '1–9', labelKey: 'l', groupKey: 'g' }),
			buildShortcutBindings(defs({ id: 'a', keys: ['1', '2', '3'] })),
			{ scopes: ['global'] }
		);
		expect(sheet[0]!.items[0]!.keys).toEqual(['1–9']);
	});
});

describe('the shipped catalog', () => {
	it('has unique ids', () => {
		const ids = SHORTCUT_CATALOG.map((def) => def.id);
		expect(ids.length).toBe(new Set(ids).size);
	});

	it('has an id shaped `scope.verb` for every entry', () => {
		const wrong = SHORTCUT_CATALOG.filter((def) => !def.id.startsWith(`${def.scope}.`));
		expect(wrong.map((def) => def.id)).toEqual([]);
	});

	it('spells every default chord in a form the registry can parse', () => {
		const broken = SHORTCUT_CATALOG.flatMap((def) =>
			def.keys.filter((key) => normalizeChord(key) === null).map((key) => `${def.id}: ${key}`)
		);
		expect(broken).toEqual([]);
	});

	it.each(SHORTCUT_PRESET_IDS)('ships the %s preset free of conflicts', (preset) => {
		const bindings = buildShortcutBindings(SHORTCUT_CATALOG, [SHORTCUT_PRESETS[preset]]);
		expect(bindings.conflicts).toEqual([]);
	});

	it('only lets a preset rebind ids the catalog actually has', () => {
		const unknown = SHORTCUT_PRESET_IDS.flatMap((preset) =>
			Object.keys(SHORTCUT_PRESETS[preset]).filter(
				(id) => !SHORTCUT_CATALOG.some((def) => def.id === id)
			)
		);
		expect(unknown).toEqual([]);
	});

	it('resolves every label and group through the real message catalog', () => {
		const { t } = createTestI18n().global;
		const missing = SHORTCUT_CATALOG.flatMap((def) =>
			[def.labelKey, def.groupKey].filter((key) => t(key) === key)
		);
		expect([...new Set(missing)]).toEqual([]);
	});

	it('documents the vocabulary the plan asked for (g-chords, n/p, z)', () => {
		const bindings = buildShortcutBindings(SHORTCUT_CATALOG);
		const chordFor = (id: string) => bindings.byId.get(id);
		expect(chordFor('postbox.goInbox')).toEqual(['g i']);
		expect(chordFor('postbox.goStarred')).toEqual(['g s']);
		expect(chordFor('postbox.goSent')).toEqual(['g t']);
		expect(chordFor('postbox.nextUnread')).toEqual(['n']);
		expect(chordFor('postbox.previousUnread')).toEqual(['p']);
		expect(chordFor('postbox.undo')).toEqual(['z']);
	});
});

describe('preferences → live bindings', () => {
	beforeEach(() => {
		resetShortcutScopes();
		resetShortcutPreferences();
	});

	it('starts on the shipped map', () => {
		expect(resolveActiveChord('h', ['postbox'])).toBe('postbox.snooze');
		expect(resolveActiveChord('b', ['postbox'])).toBe('postbox.toggleBrowse');
	});

	it('moves a key when a preset says so, and frees the one it took', () => {
		applyShortcutPreferences('gmail');
		expect(resolveActiveChord('b', ['postbox'])).toBe('postbox.snooze');
		expect(resolveActiveChord('h', ['postbox'])).toBeNull();
	});

	it('layers the user`s own remaps on top of the preset', () => {
		applyShortcutPreferences('gmail', [{ id: 'postbox.snooze', keys: ['w'] }]);
		expect(resolveActiveChord('w', ['postbox'])).toBe('postbox.snooze');
		expect(resolveActiveChord('b', ['postbox'])).toBeNull();
	});

	it('ignores a stored remap this build cannot honour', () => {
		// An id from a newer client, and one the catalog refuses to move.
		const overlay = shortcutOverridesToOverlay([
			{ id: 'postbox.timeTravel', keys: ['t'] },
			{ id: 'composer.send', keys: ['t'] },
		]);
		expect(overlay).toEqual({});
		expect(isRemappableShortcut('composer.send')).toBe(false);
		expect(isRemappableShortcut('postbox.archive')).toBe(true);
	});

	it('falls back to the shipped preset for an unknown stored value', () => {
		expect(resolveShortcutPreset('vim')).toBe('owlat');
		expect(resolveShortcutPreset(undefined)).toBe('owlat');
		expect(resolveShortcutPreset('gmail')).toBe('gmail');
	});
});

describe('the scope stack', () => {
	beforeEach(() => {
		resetShortcutScopes();
		resetShortcutPreferences();
	});

	it('always ends at global, and searches the newest claim first', () => {
		expect(activeShortcutScopes()).toEqual(['global']);
		pushShortcutScope('postbox');
		expect(activeShortcutScopes()).toEqual(['postbox', 'global']);
	});

	it('lets the Postbox shadow a global chord and hands it back on unmount', () => {
		expect(resolveActiveChord('g s')).toBe('global.goToAdmin');
		const release = pushShortcutScope('postbox');
		expect(resolveActiveChord('g s')).toBe('postbox.goStarred');
		expect(resolveActiveChord('n')).toBe('postbox.nextUnread');
		release();
		expect(resolveActiveChord('g s')).toBe('global.goToAdmin');
		expect(resolveActiveChord('n')).toBe('global.newItem');
	});

	it('ref-counts a scope so two overlapping surfaces cannot strand it', () => {
		const first = pushShortcutScope('postbox');
		const second = pushShortcutScope('postbox');
		first();
		// Idempotent: an unmount path that runs twice must not under-count.
		first();
		expect(activeShortcutScopes()).toEqual(['postbox', 'global']);
		second();
		expect(activeShortcutScopes()).toEqual(['global']);
	});

	it('resolves a live keyboard event, and knows `g` starts a chord', () => {
		expect(resolveActiveShortcut({ key: 'g' })).toBeNull();
		expect(isActiveChordPrefix('g')).toBe(true);
		expect(isActiveChordPrefix('n')).toBe(false);
		expect(resolveActiveShortcut({ key: 'k', metaKey: true })).toBe('global.commandPalette');
	});

	it('exposes the live bindings reactively for the cheat sheets', () => {
		applyShortcutPreferences('superhuman');
		expect(shortcutBindings.value.byId.get('postbox.replyAll')).toEqual(['R']);
	});
});
