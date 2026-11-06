/**
 * Preferences → Reading → read receipts: how requests are answered (ask by
 * default), and which own addresses start new drafts asking for one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PreferencesReadReceipts from '../PreferencesReadReceipts.vue';

const settings = ref<Record<string, unknown> | null | undefined>(undefined);
const addresses = ref<string[] | undefined>(undefined);
const isLoading = ref(false);
const run = vi.fn(async () => undefined);

beforeEach(() => {
	vi.clearAllMocks();
	settings.value = null;
	addresses.value = ['me@example.com', 'team@example.com'];
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('computed', computed);
	let call = 0;
	// The settings row first, the own-address list second, as the component asks.
	vi.stubGlobal('useConvexQuery', () =>
		call++ % 2 === 0 ? { data: settings, isLoading } : { data: addresses, isLoading }
	);
	vi.stubGlobal('useBackendOperation', () => ({ run, isLoading: ref(false) }));
});

function mountRows() {
	return mount(PreferencesReadReceipts, { global: { plugins: [createTestI18n()] } });
}

describe('PreferencesReadReceipts', () => {
	it('asks by default and writes another choice', async () => {
		const rows = mountRows();
		const select = rows.get<HTMLSelectElement>('#postbox-read-receipt-reply');
		expect(select.element.value).toBe('ask');

		await select.setValue('contacts');

		expect(run).toHaveBeenCalledWith({ readReceiptReply: 'contacts' });
	});

	it('lists every own address and adds one to the default set', async () => {
		settings.value = { readReceiptRequestAddresses: ['team@example.com'] };
		const rows = mountRows();
		const boxes = rows.findAll<HTMLInputElement>('input[type="checkbox"]');
		expect(boxes.map((b) => b.element.checked)).toEqual([false, true]);

		await boxes[0]!.setValue(true);

		expect(run).toHaveBeenCalledWith({
			readReceiptRequestAddresses: ['team@example.com', 'me@example.com'],
		});
	});

	it('hides the address row when there is no address to choose', () => {
		addresses.value = [];
		expect(mountRows().find('[data-testid="preferences-read-receipt-request"]').exists()).toBe(
			false
		);
	});
});
