import { afterEach, describe, expect, it } from 'vitest';
import { buildShortcutSheet } from '../shortcutRegistry';
import { SHORTCUT_CATALOG } from '../shortcutCatalog';
import { resetShortcutScopes, resolveActiveChord, shortcutBindings } from '../shortcutScope';
import { createTestI18n } from '~/__tests__/i18n';

/**
 * Answer mode's keys are bound by its pages, but the "?" sheet only knows the
 * catalog: with the `answer` scope claimed (AnswerModeFrame), the sheet lists
 * Esc, t, Cmd/Ctrl+J, 1 to 9, [ and ], and the app-wide Esc and Cmd/Ctrl+J
 * they take over drop out of it.
 */
afterEach(() => resetShortcutScopes());

describe('answer scope', () => {
	it("resolves Answer mode's keys while claimed", () => {
		expect(resolveActiveChord('t', ['answer', 'global'])).toBe('answer.toggleView');
		expect(resolveActiveChord('[', ['answer', 'global'])).toBe('answer.previousItem');
		expect(resolveActiveChord(']', ['answer', 'global'])).toBe('answer.nextItem');
		expect(resolveActiveChord('3', ['answer', 'global'])).toBe('answer.pickAskOption');
		expect(resolveActiveChord('t', ['global'])).toBeNull();
	});

	it('puts them on the cheat sheet in one group, over the globals they shadow', () => {
		const groups = buildShortcutSheet(SHORTCUT_CATALOG, shortcutBindings.value, {
			scopes: ['answer', 'global'],
		});
		const answer = groups.find((g) => g.groupKey === 'shared.shortcuts.groups.answer');
		expect(answer?.items.map((i) => i.id)).toEqual([
			'answer.leave',
			'answer.toggleView',
			'answer.writeNote',
			'answer.draftWithAi',
			'answer.pickAskOption',
			'answer.previousItem',
			'answer.nextItem',
		]);
		const ids = groups.flatMap((g) => g.items.map((i) => i.id));
		expect(ids).not.toContain('global.close');
	});

	it('says where the note key works, since personal mail has no notes', () => {
		// Both Answer pages claim the `answer` scope, so the sheet lists `n` on a
		// personal message too, where it does nothing.
		const note = SHORTCUT_CATALOG.find((entry) => entry.id === 'answer.writeNote');
		const { t } = createTestI18n().global;
		expect(t(note!.labelKey)).toBe('Write an internal note (Team inbox threads)');
	});
});
