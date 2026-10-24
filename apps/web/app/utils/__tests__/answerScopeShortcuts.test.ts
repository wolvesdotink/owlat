import { afterEach, describe, expect, it } from 'vitest';
import { buildShortcutSheet } from '../shortcutRegistry';
import { SHORTCUT_CATALOG } from '../shortcutCatalog';
import { resetShortcutScopes, resolveActiveChord, shortcutBindings } from '../shortcutScope';
import { createTestI18n } from '~/__tests__/i18n';

/**
 * Answer mode and its queue cards answer through the catalog: with the
 * `answer` scope claimed (AnswerModeFrame), the "?" sheet lists Esc, t, n,
 * Cmd/Ctrl+J, [ and ], e and h, and the app-wide Esc and Cmd/Ctrl+J (the
 * Assistant) they take over drop out of it. The queue's cards reuse keys, so
 * each kind has a scope of its own.
 */
afterEach(() => resetShortcutScopes());

describe('answer scope', () => {
	it("resolves Answer mode's keys while claimed", () => {
		expect(resolveActiveChord('t', ['answer', 'global'])).toBe('answer.toggleView');
		expect(resolveActiveChord('[', ['answer', 'global'])).toBe('answer.previousItem');
		expect(resolveActiveChord(']', ['answer', 'global'])).toBe('answer.nextItem');
		expect(resolveActiveChord('mod+j', ['answer', 'global'])).toBe('answer.draftWithAi');
		expect(resolveActiveChord('3', ['askCard', 'answer', 'global'])).toBe('askCard.pickOption');
		expect(resolveActiveChord('mod+z', ['answerQueue', 'global'])).toBe('answerQueue.undo');
		expect(resolveActiveChord('t', ['global'])).toBeNull();
		expect(resolveActiveChord('mod+j', ['global'])).toBe('global.assistant');
	});

	it.each([
		['mailCard', 'Enter', 'mailCard.done'],
		['teamCard', 'Enter', 'teamCard.send'],
		['mentionCard', 'Enter', 'mentionCard.reply'],
		['mentionCard', 's', 'mentionCard.skip'],
		['teamCard', 'x', 'teamCard.reject'],
		['mailCard', 'ArrowRight', 'mailCard.next'],
	] as const)('gives the %s card its own meaning for %s', (scope, key, id) => {
		expect(resolveActiveChord(key, [scope, 'answerQueue', 'global'])).toBe(id);
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
			'answer.previousItem',
			'answer.nextItem',
			'answer.archive',
			'answer.snooze',
		]);
		const ids = groups.flatMap((g) => g.items.map((i) => i.id));
		expect(ids).not.toContain('global.close');
		expect(ids).not.toContain('global.assistant');
	});

	it('says where the note key works, since personal mail has no notes', () => {
		// Both Answer pages claim the `answer` scope, so the sheet lists `n` on a
		// personal message too, where it does nothing.
		const note = SHORTCUT_CATALOG.find((entry) => entry.id === 'answer.writeNote');
		const { t } = createTestI18n().global;
		expect(t(note!.labelKey)).toBe('Write an internal note (Team inbox threads)');
	});
});
