import { computed, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '@owlat/api/dataModel';
import { useCampaignActions } from '../useCampaignActions';
import { SEND_UNDO_WINDOW_MS } from '~/lib/campaignSend';
import { createTestI18n } from '~/__tests__/i18n';
import type { useCampaignABTest } from '../useCampaignABTest';

type ABTest = ReturnType<typeof useCampaignABTest>;

/** The real catalog behind the `useI18n` auto-import the composable calls. */
const i18n = createTestI18n();

/**
 * "Send now" from the campaign editor.
 *
 * The one irreversible action in the product used to fire `campaigns.sendNow`
 * straight off a button and then hop to the campaigns list on a 1.5s timer (UX
 * plan T3). It now holds the send one undo window out — a real scheduled
 * campaign, same `schedule` mutation, same pre-flight — arms the undo toast,
 * and lands on the report where that toast lives and the numbers appear.
 */
describe('useCampaignActions send now', () => {
	const runs: { label: string; args: unknown }[] = [];
	const pushed: string[] = [];
	const armed: unknown[] = [];

	const makeActions = (status: 'draft' | 'scheduled') =>
		useCampaignActions({
			campaignId: ref('campaign_1' as Id<'campaigns'>),
			abTest: {
				abTestEnabled: ref(false),
				buildEnablePayload: () => ({}),
			} as unknown as ABTest,
			campaignData: ref<Doc<'campaigns'> | null>({
				name: 'Weekly digest #34',
				isABTest: false,
			} as unknown as Doc<'campaigns'>),
			isDraft: computed(() => status === 'draft'),
			isScheduled: computed(() => status === 'scheduled'),
			validateForm: () => true,
			handleSaveFields: async () => true,
		});

	const labelled = (label: string) => runs.filter((run) => run.label === label);

	beforeEach(() => {
		runs.length = 0;
		pushed.length = 0;
		armed.length = 0;
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-10T09:00:00'));
		vi.stubGlobal('useI18n', () => i18n.global);
		vi.stubGlobal('useRouter', () => ({ push: (to: string) => pushed.push(to) }));
		vi.stubGlobal('useToast', () => ({ showToast: () => {} }));
		vi.stubGlobal('useCampaignUndoSend', () => ({ arm: (args: unknown) => armed.push(args) }));
		vi.stubGlobal(
			'useBackendOperation',
			(_reference: unknown, options: { label: string | (() => string) }) => ({
				run: async (args: unknown) => {
					const label = typeof options.label === 'function' ? options.label() : options.label;
					runs.push({ label, args });
					return { ok: true, result: 'campaign_1' };
				},
			})
		);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('schedules the send one undo window out instead of sending immediately', async () => {
		const actions = makeActions('draft');

		await actions.handleSendNow();

		expect(labelled('Schedule campaign')).toEqual([
			{
				label: 'Schedule campaign',
				args: {
					campaignId: 'campaign_1',
					scheduledAt: Date.now() + SEND_UNDO_WINDOW_MS,
					// An immediate send is never staggered by recipient timezone,
					// whatever the schedule form's toggle happens to say.
					useRecipientTimezone: false,
				},
			},
		]);
		// The mutation that cannot be taken back is not called at all any more.
		expect(labelled('Send campaign now')).toEqual([]);
	});

	it('arms the undo window with the campaign it just held', async () => {
		const actions = makeActions('draft');

		await actions.handleSendNow();

		expect(armed).toEqual([
			{
				campaignId: 'campaign_1',
				campaignName: 'Weekly digest #34',
				sendAt: Date.now() + SEND_UNDO_WINDOW_MS,
			},
		]);
	});

	it('lands on the report, with no timer between the click and the page', async () => {
		const actions = makeActions('draft');

		await actions.handleSendNow();

		expect(pushed).toEqual(['/dashboard/campaigns/campaign_1/report']);
		vi.advanceTimersByTime(5000);
		expect(pushed).toEqual(['/dashboard/campaigns/campaign_1/report']);
	});

	it('returns an already-scheduled campaign to draft first, because schedule only takes drafts', async () => {
		const actions = makeActions('scheduled');

		await actions.handleSendNow();

		expect(runs.map((run) => run.label)).toEqual(['Unschedule campaign', 'Schedule campaign']);
	});

	it('arms nothing and goes nowhere when the schedule is refused', async () => {
		vi.stubGlobal(
			'useBackendOperation',
			(_reference: unknown, options: { label: string | (() => string) }) => ({
				run: async () => {
					const label = typeof options.label === 'function' ? options.label() : options.label;
					return label === 'Schedule campaign' ? { ok: false } : { ok: true, result: null };
				},
			})
		);
		const actions = makeActions('draft');

		await actions.handleSendNow();

		expect(armed).toEqual([]);
		expect(pushed).toEqual([]);
	});
});
