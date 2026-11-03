/**
 * The read-receipt lines under a sent message, against the real catalog: who
 * sent a receipt back, who has not, and the reminder that "no receipt" is not
 * "unread".
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mount } from '@vue/test-utils';

import PostboxReadReceipts from '../PostboxReadReceipts.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { ReadReceiptRecord } from '~/utils/postboxReadReceipts';
import { readReceiptView } from '~/utils/postboxReadReceipts';

const AT = Date.UTC(2026, 10, 3, 9, 12);

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

function mountReceipts(receipt: ReadReceiptRecord, recipients: string[]) {
	return mount(PostboxReadReceipts, {
		props: { receipt, recipients },
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: { props: ['name'], template: '<span />' } },
		},
	});
}

describe('PostboxReadReceipts', () => {
	it('names the reader of a returned receipt', () => {
		const w = mountReceipts(
			{
				requestedAt: AT - 1,
				returned: [
					{ address: 'ben@example.com', disposition: 'displayed', isAutomatic: false, at: AT },
				],
			},
			['ben@example.com']
		);
		expect(w.text()).toContain('Read by ben@example.com');
		expect(w.text()).not.toContain('No read receipt');
	});

	it('says a missing receipt does not mean unread', () => {
		const w = mountReceipts({ requestedAt: AT, returned: [] }, ['ben@example.com']);
		expect(w.text()).toContain('No read receipt from ben@example.com yet.');
		expect(w.text()).toContain("doesn't mean the message is unread");
	});

	it('counts the recipients still without a receipt', () => {
		const w = mountReceipts(
			{
				requestedAt: AT,
				returned: [
					{ address: 'ben@example.com', disposition: 'deleted', isAutomatic: true, at: AT },
				],
			},
			['ben@example.com', 'cy@example.com', 'di@example.com']
		);
		expect(w.text()).toContain('Deleted without being read by ben@example.com');
		expect(w.text()).toContain('No read receipt from 2 recipients yet.');
	});
});

describe('readReceiptView', () => {
	it('lists each waiting recipient once, case-insensitively', () => {
		const view = readReceiptView(
			{
				requestedAt: AT,
				returned: [
					{ address: 'ben@example.com', disposition: 'displayed', isAutomatic: false, at: AT },
				],
			},
			['Ben@Example.com', 'cy@example.com', 'CY@example.com']
		);
		expect(view.waiting).toEqual(['cy@example.com']);
	});
});
