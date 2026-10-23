/**
 * "Cancel send" from the scheduled-campaign reminder opens the campaign with
 * `?intent=cancel`: the page asks before cancelling, drops the intent from the
 * address, and says so when the campaign is no longer scheduled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { nextTick, reactive, ref, watch } from 'vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import CampaignCancelIntentDialog from '../CampaignCancelIntentDialog.vue';

const route = reactive<{ query: Record<string, string> }>({ query: {} });
const replace = vi.fn(async ({ query }: { query: Record<string, string> }) => {
	route.query = query;
});
const showToast = vi.fn();

// Every mounted dialog watches the shared route: one left over from an earlier
// case would handle the next case's intent first.
enableAutoUnmount(afterEach);

beforeEach(() => {
	vi.clearAllMocks();
	route.query = {};
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('ref', ref);
	vi.stubGlobal('watch', watch);
	vi.stubGlobal('useRoute', () => route);
	vi.stubGlobal('useRouter', () => ({ replace }));
	vi.stubGlobal('useToast', () => ({ showToast }));
});

function mountDialog(props: { isLoaded: boolean; isScheduled: boolean }) {
	return mount(CampaignCancelIntentDialog, {
		props: {
			name: 'Webinar',
			scheduledAtDisplay: '10/24/2026, 2:00 PM',
			isLoading: false,
			...props,
		},
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiConfirmationDialog: {
					props: ['open', 'title', 'description', 'confirmText', 'cancelText'],
					emits: ['confirm', 'update:open'],
					template:
						'<div v-if="open" data-testid="dialog"><h2>{{ title }}</h2><p>{{ description }}</p><button data-testid="confirm" @click="$emit(\'confirm\')">{{ confirmText }}</button><button data-testid="keep" @click="$emit(\'update:open\', false)">{{ cancelText }}</button></div>',
				},
			},
		},
	});
}

describe('CampaignCancelIntentDialog', () => {
	it('stays closed without the intent', () => {
		expect(
			mountDialog({ isLoaded: true, isScheduled: true }).find('[data-testid="dialog"]').exists()
		).toBe(false);
	});

	it('waits for the campaign, then asks, drops the intent and confirms on request', async () => {
		route.query = { intent: 'cancel', tab: 'content' };
		const w = mountDialog({ isLoaded: false, isScheduled: false });
		expect(w.find('[data-testid="dialog"]').exists()).toBe(false);
		await w.setProps({ isLoaded: true, isScheduled: true });
		await nextTick();
		expect(replace).toHaveBeenCalledWith({ query: { tab: 'content' } });
		expect(w.get('[data-testid="dialog"]').text()).toContain('Webinar is scheduled to send on');
		expectFullyLocalized(w);
		await w.get('[data-testid="confirm"]').trigger('click');
		expect(w.emitted('confirm')).toHaveLength(1);
		expect(w.find('[data-testid="dialog"]').exists()).toBe(false);
	});

	it('keeps the campaign when the person says so', async () => {
		route.query = { intent: 'cancel' };
		const w = mountDialog({ isLoaded: true, isScheduled: true });
		await nextTick();
		await w.get('[data-testid="keep"]').trigger('click');
		expect(w.emitted('confirm')).toBeUndefined();
		expect(w.find('[data-testid="dialog"]').exists()).toBe(false);
	});

	it('says there is nothing to cancel when the campaign is no longer scheduled', async () => {
		route.query = { intent: 'cancel' };
		const w = mountDialog({ isLoaded: true, isScheduled: false });
		await nextTick();
		expect(w.find('[data-testid="dialog"]').exists()).toBe(false);
		expect(showToast).toHaveBeenCalledWith(
			'This campaign is no longer scheduled, so there is nothing to cancel.',
			'info'
		);
	});
});
