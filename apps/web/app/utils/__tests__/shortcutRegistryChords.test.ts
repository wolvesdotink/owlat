/**
 * The registry rules the shortcuts page leans on: one spelling per chord a
 * keyboard can produce (Shift in a letter's case, Caps Lock ignored next to a
 * modifier), a conflict for a chord that starts another in its scope, and a
 * reason on every fixed entry.
 */
import { describe, expect, it } from 'vitest';
import {
	buildShortcutBindings,
	chordFromEvent,
	formatChord,
	isModifierChord,
	normalizeChord,
	type ShortcutDefinition,
} from '../shortcutRegistry';
import { SHORTCUT_CATALOG } from '../shortcutCatalog';
import { SHORTCUT_PRESETS, SHORTCUT_PRESET_IDS } from '../shortcutPresets';

const defs = (...entries: Partial<ShortcutDefinition>[]): ShortcutDefinition[] =>
	entries.map((entry, index) => ({
		id: `test.${index}`,
		scope: 'global',
		keys: [],
		labelKey: 'x',
		groupKey: 'g',
		...entry,
	}));

describe('modifier chords', () => {
	it('takes a letter’s case from Shift, not from Caps Lock or the browser', () => {
		expect(chordFromEvent({ key: 'J', metaKey: true })).toBe('mod+j');
		expect(chordFromEvent({ key: 'j', ctrlKey: true, shiftKey: true })).toBe('mod+J');
		expect(chordFromEvent({ key: 'F', metaKey: true, shiftKey: true })).toBe('mod+F');
		// A bare letter keeps its case: Shift+u is `U`, as before.
		expect(chordFromEvent({ key: 'U', shiftKey: true })).toBe('U');
	});

	it('writes Shift+letter one way, however the catalog spelled it', () => {
		expect(normalizeChord('mod+shift+F')).toBe('mod+F');
		expect(normalizeChord('mod+shift+f')).toBe('mod+F');
		expect(normalizeChord('shift+a')).toBe('A');
		expect(normalizeChord('mod+shift+Enter')).toBe('mod+shift+Enter');
	});

	it('prints the Shift a capital letter carries next to a modifier', () => {
		expect(formatChord('mod+J', false)).toEqual(['Ctrl', 'Shift', 'J']);
		expect(formatChord('mod+shift+F', true)).toEqual(['⌘', 'Shift', 'F']);
		expect(formatChord('U', false)).toEqual(['U']);
	});

	it('knows a modifier chord from a single key or a sequence', () => {
		expect(isModifierChord('mod+,')).toBe(true);
		expect(isModifierChord('alt+1')).toBe(true);
		expect(isModifierChord('g d')).toBe(false);
		expect(isModifierChord('ArrowDown')).toBe(false);
		expect(isModifierChord('+')).toBe(false);
	});
});

describe('prefix conflicts', () => {
	it('reports a key that starts another chord in its own scope', () => {
		const catalog = defs({ keys: ['g'] }, { keys: ['g d'] });
		expect(buildShortcutBindings(catalog).conflicts).toEqual([
			{ scope: 'global', chord: 'g', ids: ['test.0', 'test.1'], kind: 'prefix' },
		]);
	});

	it('leaves a prefix in another scope alone: shadowing across scopes is by design', () => {
		const catalog = defs({ keys: ['g'], scope: 'postbox' }, { keys: ['g d'] });
		expect(buildShortcutBindings(catalog).conflicts).toEqual([]);
	});

	it.each(SHORTCUT_PRESET_IDS)('ships the %s preset with no prefix conflict', (preset) => {
		const bindings = buildShortcutBindings(SHORTCUT_CATALOG, [SHORTCUT_PRESETS[preset]]);
		expect(bindings.conflicts.filter((c) => c.kind === 'prefix')).toEqual([]);
	});
});

describe('the shipped catalog', () => {
	it('names a reason on every fixed entry, and on no other', () => {
		const wrong = SHORTCUT_CATALOG.filter(
			(def) => (def.remappable === false) !== (def.fixedReason !== undefined)
		);
		expect(wrong.map((def) => def.id)).toEqual([]);
	});

	it('catalogues the keys the shell, the Team inbox and the Workbench answer', () => {
		const bindings = buildShortcutBindings(SHORTCUT_CATALOG);
		expect(bindings.byId.get('global.settings')).toEqual(['mod+,']);
		expect(bindings.byId.get('global.assistant')).toEqual(['mod+j']);
		expect(bindings.byId.get('global.toggleSidebar')).toEqual(['mod+\\']);
		expect(bindings.byId.get('inbox.assignToMe')).toEqual(['i']);
		expect(bindings.byId.get('inbox.reply')).toEqual(['r']);
		expect(bindings.byId.get('inbox.note')).toEqual(['n']);
		expect(bindings.byId.get('workbench.next')).toEqual(['j']);
		expect(bindings.byId.get('workbench.done')).toEqual(['d']);
		expect(bindings.byId.get('peek.next')).toEqual(['j', 'ArrowDown']);
		const remappable = (id: string) =>
			SHORTCUT_CATALOG.find((def) => def.id === id)?.remappable !== false;
		for (const id of ['global.settings', 'global.assistant', 'global.toggleSidebar']) {
			expect(remappable(id)).toBe(true);
		}
	});
});
