// @vitest-environment happy-dom
/**
 * The campaign undo-send toast: the 60 seconds in which the one irreversible
 * action in the product is still reversible (UX plan T3).
 *
 * What matters here is that Undo does the RIGHT reversal. The held send is a
 * real scheduled campaign, so undo is `scheduling.unschedule` — back to draft,
 * editable, re-sendable. `scheduling.cancel` would also stop the send and would
 * also look fine in a screenshot, but `cancelled` is a terminal lifecycle state:
 * it answers "I didn't mean to press that" by destroying the campaign.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';

import UndoSendToast from '../UndoSendToast.vue';
import { useCampaignUndoSend } from '~/composables/useCampaignUndoSend';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

const CAMPAIGN_ID = 'campaign_1' as Id<'campaigns'>;

const stateBuckets = new Map<string, ReturnType<typeof ref>>();
const unscheduleRuns: unknown[] = [];
const pushed: string[] = [];
const toasts: string[] = [];
let unscheduleOk = true;

beforeEach(() => {
	stateBuckets.clear();
	unscheduleRuns.length = 0;
	pushed.length = 0;
	toasts.length = 0;
	unscheduleOk = true;
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-03-10T09:00:00'));

	vi.stubGlobal('useState', (key: string, init: () => unknown) => {
		if (!stateBuckets.has(key)) stateBuckets.set(key, ref(init()));
		return stateBuckets.get(key);
	});
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useRouter', () => ({ push: (to: string) => pushed.push(to) }));
	vi.stubGlobal('useToast', () => ({ showToast: (message: string) => toasts.push(message) }));
	vi.stubGlobal('useConvex', () => null);
	vi.stubGlobal('useCampaignUndoSend', useCampaignUndoSend);
	vi.stubGlobal(
		'useBackendOperation',
		(_reference: unknown, options: { label: string | (() => string) }) => ({
			run: async (args: unknown) => {
				const label = typeof options.label === 'function' ? options.label() : options.label;
				if (label === 'Call back campaign send') unscheduleRuns.push(args);
				return unscheduleOk ? { ok: true, result: CAMPAIGN_ID } : { ok: false };
			},
		})
	);
});

afterEach(() => {
	vi.useRealTimers();
	// Not `unstubAllGlobals`: the shared setup file installs Vue's reactivity API
	// as globals for SFC mounts, and clearing every stub takes those with it.
});

function mountToast() {
	return mount(UndoSendToast, {
		global: { plugins: [createTestI18n()], stubs: { Icon: true } },
	});
}

function armWindow(sendAtOffsetMs: number) {
	useCampaignUndoSend().arm({
		campaignId: CAMPAIGN_ID,
		campaignName: 'Weekly digest #34',
		sendAt: Date.now() + sendAtOffsetMs,
	});
}

describe('CampaignsUndoSendToast', () => {
	it('shows nothing until a send is armed', () => {
		expect(mountToast().find('button').exists()).toBe(false);
	});

	it('counts the armed window down, naming the campaign', async () => {
		armWindow(60_000);
		const wrapper = mountToast();
		await flushPromises();

		expect(wrapper.text()).toContain('Sending "Weekly digest #34" in 60s');
		expectFullyLocalized(wrapper);

		vi.advanceTimersByTime(30_000);
		await flushPromises();
		expect(wrapper.text()).toContain('in 30s');
	});

	it('disappears once the window has run out — the send is gone', async () => {
		armWindow(1_000);
		const wrapper = mountToast();

		vi.advanceTimersByTime(1_500);
		await flushPromises();

		expect(wrapper.find('button').exists()).toBe(false);
		expect(unscheduleRuns).toEqual([]);
	});

	it('undo puts the campaign back to draft and returns to the editor', async () => {
		armWindow(60_000);
		const wrapper = mountToast();
		await flushPromises();

		await wrapper.find('button').trigger('click');
		await flushPromises();

		expect(unscheduleRuns).toEqual([{ campaignId: CAMPAIGN_ID }]);
		expect(toasts).toEqual(['Send called back. The campaign is a draft again.']);
		expect(pushed).toEqual([`/dashboard/campaigns/${CAMPAIGN_ID}/edit`]);
		expect(wrapper.find('button').exists()).toBe(false);
	});

	it('keeps the window open when the reversal is refused', async () => {
		unscheduleOk = false;
		armWindow(60_000);
		const wrapper = mountToast();
		await flushPromises();

		await wrapper.find('button').trigger('click');
		await flushPromises();

		// The send is still coming and the operation module has already said why,
		// so the button stays clickable rather than pretending it worked.
		expect(pushed).toEqual([]);
		expect(toasts).toEqual([]);
		expect(wrapper.find('button').exists()).toBe(true);
	});
});
