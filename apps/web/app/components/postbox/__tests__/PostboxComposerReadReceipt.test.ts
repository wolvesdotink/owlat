/**
 * "Ask for a read receipt" in the composer's ⋯ menu: off unless the saved draft
 * says otherwise, and a toggle creates the row first when there is none.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';

import PostboxComposerReadReceipt from '../PostboxComposerReadReceipt.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const draftRow = ref<{ isReadReceiptRequested?: boolean } | undefined>(undefined);
const run = vi.fn(async () => ({ ok: true as const, result: null }));

beforeEach(() => {
	draftRow.value = undefined;
	run.mockClear();
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useConvexQuery', () => ({ data: draftRow }));
	vi.stubGlobal('useBackendOperation', () => ({ run }));
	vi.stubGlobal('useOperationErrorToast', () => ({ showOperationError: vi.fn() }));
});

function mountToggle(draftId: string | null) {
	const ensureDraft = vi.fn(async () => 'draft1');
	const wrapper = mount(PostboxComposerReadReceipt, {
		props: {
			compose: {
				draftId: ref(draftId),
				ensureDraft,
				isScheduled: ref(false),
			} as never,
		},
		global: {
			plugins: [createTestI18n()],
		},
	});
	return { wrapper, ensureDraft };
}

describe('PostboxComposerReadReceipt', () => {
	it('starts off and asks for a receipt on a draft that has no row yet', async () => {
		const { wrapper, ensureDraft } = mountToggle(null);
		const item = wrapper.get('[data-testid="composer-read-receipt"]');
		expect(item.text()).toBe('Ask for a read receipt');
		expect(item.attributes('aria-checked')).toBe('false');

		await item.trigger('click');
		await flushPromises();

		expect(ensureDraft).toHaveBeenCalled();
		expect(run).toHaveBeenCalledWith({ draftId: 'draft1', isRequested: true });
		expect(item.attributes('aria-checked')).toBe('true');
	});

	it('shows the saved choice and turns it off', async () => {
		draftRow.value = { isReadReceiptRequested: true };
		const { wrapper } = mountToggle('draft1');
		const item = wrapper.get('[data-testid="composer-read-receipt"]');
		expect(item.attributes('aria-checked')).toBe('true');

		await item.trigger('click');
		await flushPromises();

		expect(run).toHaveBeenCalledWith({ draftId: 'draft1', isRequested: false });
		expect(item.attributes('aria-checked')).toBe('false');
	});
});
