import { describe, expect, it } from 'vitest';
import {
	filtersOnNewMail,
	isFilterActionAvailable,
	type FilterActionType,
} from '../usePostboxFilters';

const HOSTED_PERSONAL = { scope: 'personal' as const };
const HOSTED_TEAM = { scope: 'shared' as const, kind: 'hosted' as const };
const CONNECTED_PERSONAL = { kind: 'external' as const };
const CONNECTED_TEAM = { scope: 'shared' as const, kind: 'external' as const };

/**
 * Hosted delivery runs the editor's filters before the insert and the
 * plain-language and AI rules after it, the latter for a personal mailbox only.
 * Mail synced from a provider runs only the second pass.
 */
describe('what runs on new mail, per mailbox', () => {
	it('runs both kinds of rule in a hosted personal mailbox', () => {
		expect(filtersOnNewMail(HOSTED_PERSONAL)).toEqual({ editorFilters: true, plainRules: true });
		expect(filtersOnNewMail({})).toEqual({ editorFilters: true, plainRules: true });
	});

	it('runs only the editor filters in a hosted team inbox', () => {
		expect(filtersOnNewMail(HOSTED_TEAM)).toEqual({ editorFilters: true, plainRules: false });
	});

	it('runs only the plain-language rules in a connected personal mailbox', () => {
		expect(filtersOnNewMail(CONNECTED_PERSONAL)).toEqual({
			editorFilters: false,
			plainRules: true,
		});
	});

	it('runs nothing in a connected team inbox', () => {
		expect(filtersOnNewMail(CONNECTED_TEAM)).toEqual({ editorFilters: false, plainRules: false });
	});
});

describe('which filter actions can take effect, per mailbox', () => {
	const EDITOR_ACTIONS: FilterActionType[] = [
		'moveToFolder',
		'addLabel',
		'markRead',
		'markFlagged',
		'pinToSection',
		'forward',
		'delete',
		'discard',
	];

	it('offers every action on a hosted mailbox', () => {
		for (const mailbox of [HOSTED_PERSONAL, HOSTED_TEAM]) {
			for (const type of EDITOR_ACTIONS) {
				expect(isFilterActionAvailable(type, mailbox)).toBe(true);
			}
		}
	});

	it('offers only what "Run on existing mail" applies on a connected mailbox', () => {
		for (const mailbox of [CONNECTED_PERSONAL, CONNECTED_TEAM]) {
			const available = EDITOR_ACTIONS.filter((type) => isFilterActionAvailable(type, mailbox));
			expect(available).toEqual([
				'moveToFolder',
				'addLabel',
				'markRead',
				'markFlagged',
				'pinToSection',
			]);
		}
	});
});
