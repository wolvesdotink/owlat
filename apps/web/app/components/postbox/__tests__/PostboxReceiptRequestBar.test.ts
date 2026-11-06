/**
 * A sender's read-receipt request in the reader: Send / Don't send until
 * someone answers, then a line saying what was answered, with Send kept on a
 * declined request.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';

import PostboxReceiptRequestBar from '../PostboxReceiptRequestBar.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const run = vi.fn(async () => ({ ok: true as const, result: null }));

const UiButton = {
	emits: ['click'],
	template: '<button type="button" @click="$emit(\'click\')"><slot /></button>',
};

beforeEach(() => {
	run.mockClear();
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useBackendOperation', () => ({ run, isLoading: ref(false) }));
});

type Request = {
	address: string;
	requestedAt: number;
	answeredAt?: number;
	answer?: 'sent' | 'declined';
	isAutomatic?: boolean;
};

function mountBar(receiptRequest: Request | undefined) {
	return mount(PostboxReceiptRequestBar, {
		props: {
			message: {
				_id: 'm1',
				fromAddress: 'ben@example.org',
				fromName: 'Ben Ortiz',
				receiptRequest,
			},
		},
		global: { plugins: [createTestI18n()], stubs: { UiButton } },
	});
}

const asked: Request = { address: 'ben@example.org', requestedAt: 1 };

describe('PostboxReceiptRequestBar', () => {
	it('asks, and sends a receipt on Send', async () => {
		const wrapper = mountBar(asked);
		expect(wrapper.text()).toContain('Ben Ortiz asked for a read receipt.');

		await wrapper.get('[data-testid="reader-receipt-request-send"]').trigger('click');

		expect(run).toHaveBeenCalledWith({ messageId: 'm1', answer: 'send' });
	});

	it("declines on Don't send", async () => {
		const wrapper = mountBar(asked);

		await wrapper.get('[data-testid="reader-receipt-request-decline"]').trigger('click');

		expect(run).toHaveBeenCalledWith({ messageId: 'm1', answer: 'decline' });
	});

	it('says a receipt went out and offers nothing more', () => {
		const wrapper = mountBar({ ...asked, answeredAt: 2, answer: 'sent', isAutomatic: true });

		expect(wrapper.get('[data-testid="reader-receipt-request-answer"]').text()).toContain(
			'automatically'
		);
		expect(wrapper.find('[data-testid="reader-receipt-request-send"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="reader-receipt-request-decline"]').exists()).toBe(false);
	});

	it('keeps Send on a declined request', async () => {
		const wrapper = mountBar({ ...asked, answeredAt: 2, answer: 'declined' });
		expect(wrapper.get('[data-testid="reader-receipt-request-answer"]').text()).toBe(
			"You didn't send Ben Ortiz a read receipt."
		);

		await wrapper.get('[data-testid="reader-receipt-request-send"]').trigger('click');

		expect(run).toHaveBeenCalledWith({ messageId: 'm1', answer: 'send' });
	});

	it('renders nothing without a request', () => {
		expect(mountBar(undefined).find('[data-testid="reader-receipt-request"]').exists()).toBe(false);
	});
});
