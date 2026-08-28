/**
 * What an empty Postbox folder says.
 *
 * The failure this guards is a filtered-to-zero list claiming "All clear",
 * which reads as "your mail is gone" — so the ordering of the four cases is the
 * behaviour, and it is pinned here rather than by mounting the list four times.
 */
import { describe, expect, it } from 'vitest';
import { postboxListEmptyState } from '../postboxListEmptyState';

const BASE = { filterActive: false, hasMore: false, folderRole: 'inbox' } as const;

describe('postboxListEmptyState', () => {
	it('offers inbox zero its own moment', () => {
		const state = postboxListEmptyState({ ...BASE });
		expect(state.titleKey).toMatch(/emptyInboxTitle$/);
		expect(state.hintKey).toMatch(/emptyInboxHint$/);
		expect(state.showFilterAction).toBe(false);
	});

	it('says "nothing matches", not "all clear", when a chip is hiding rows', () => {
		const state = postboxListEmptyState({ ...BASE, filterActive: true });
		expect(state.titleKey).toMatch(/emptyFilteredTitle$/);
		expect(state.hintKey).toBeUndefined();
	});

	it('admits the filter only searched the loaded pages while more exist', () => {
		const state = postboxListEmptyState({ ...BASE, filterActive: true, hasMore: true });
		expect(state.hintKey).toMatch(/emptyFilteredMoreHint$/);
	});

	it('outranks the label view over the inbox role it borrows for row links', () => {
		const state = postboxListEmptyState({ ...BASE, emptyContext: 'label' });
		expect(state.titleKey).toMatch(/emptyLabelTitle$/);
	});

	it('points an empty custom folder at the filter that would fill it', () => {
		const state = postboxListEmptyState({ ...BASE, folderRole: '' });
		expect(state.titleKey).toMatch(/emptyFolderTitle$/);
		expect(state.showFilterAction).toBe(true);
	});

	it('keeps other system folders neutral and hint-free', () => {
		const state = postboxListEmptyState({ ...BASE, folderRole: 'archive' });
		expect(state.titleKey).toMatch(/emptyDefaultTitle$/);
		expect(state.hintKey).toBeUndefined();
		expect(state.showFilterAction).toBe(false);
	});
});
