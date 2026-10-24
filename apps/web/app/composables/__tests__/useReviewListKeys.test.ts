/**
 * The Team inbox Updates list answers every key from the `review` scope:
 * move, open, Done (`d`) and Draft a reply (`r`), so a remap moves Done and
 * Draft a reply as it moves the rest, and the legend follows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useReviewListKeys } from '../useReviewListKeys';
import {
	activeShortcutScopes,
	applyShortcutPreferences,
	resetShortcutPreferences,
	resetShortcutScopes,
} from '~/utils/shortcutScope';

afterEach(() => {
	resetShortcutPreferences();
	resetShortcutScopes();
});

function setup() {
	const onDismiss = vi.fn();
	const onRequestReply = vi.fn();
	let keys!: ReturnType<typeof useReviewListKeys<{ _id: string }>>;
	const wrapper = mount(
		defineComponent({
			setup() {
				keys = useReviewListKeys({
					items: ref([{ _id: 'a' }, { _id: 'b' }]),
					resetKey: ref('all'),
					rowDomId: (row) => `row-${row._id}`,
					onOpen: vi.fn(),
					onDismiss,
					onRequestReply,
				});
				return () => null;
			},
		})
	);
	const press = (key: string) => keys.onKeydown(new KeyboardEvent('keydown', { key }));
	return { wrapper, keys, press, onDismiss, onRequestReply };
}

describe('useReviewListKeys', () => {
	it('claims the review scope while mounted', () => {
		const { wrapper } = setup();
		expect(activeShortcutScopes()).toContain('review');
		wrapper.unmount();
		expect(activeShortcutScopes()).not.toContain('review');
	});

	it('marks the focused row done with d and drafts a reply with r', () => {
		const { press, onDismiss, onRequestReply } = setup();
		press('j');
		press('d');
		press('r');
		expect(onDismiss).toHaveBeenCalledWith({ _id: 'a' });
		expect(onRequestReply).toHaveBeenCalledWith({ _id: 'a' });
	});

	it('follows a remap, in the keys and in the legend', () => {
		applyShortcutPreferences('owlat', [{ id: 'review.dismiss', keys: ['x'] }]);
		const { keys, press, onDismiss } = setup();
		press('j');
		press('d');
		expect(onDismiss).not.toHaveBeenCalled();
		press('x');
		expect(onDismiss).toHaveBeenCalledTimes(1);
		expect(keys.hints.value.map((hint) => hint.keys)).toEqual([
			['J', 'K'],
			['Enter'],
			['X'],
			['R'],
		]);
	});
});
