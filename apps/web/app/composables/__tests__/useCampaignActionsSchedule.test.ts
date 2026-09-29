import { computed, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '@owlat/api/dataModel';
import type { OperationError } from '@owlat/shared/operationError';
import { useCampaignActions } from '../useCampaignActions';
import { createTestI18n } from '~/__tests__/i18n';
import type { useCampaignABTest } from '../useCampaignABTest';

type ABTest = ReturnType<typeof useCampaignABTest>;

/** The real catalog behind the `useI18n` auto-import the composable calls. */
const i18n = createTestI18n();

/**
 * The schedule submit path judges "is this start in the past?" against a LIVE
 * clock, not against whatever the clock said when the date/time controls were
 * last touched.
 *
 * `scheduledStartAt` is a `computed`, and `Date.now()` is not a reactive
 * dependency, so its value is only recomputed when one of the two form refs
 * changes. That caching is correct for the capacity PREVIEW and wrong for the
 * pre-submit check: an editor left open past the chosen instant would otherwise
 * skip the inline "Scheduled time must be in the future" message and send a
 * past `scheduledAt` to the server, which rejects it as a toast. These cases
 * pin the boundary in both directions.
 */
describe('useCampaignActions schedule clock', () => {
	const scheduleRuns: unknown[] = [];
	const rescheduleRuns: unknown[] = [];

	const makeActions = (isDraft: boolean) => {
		const campaignId = ref('campaign_1' as Id<'campaigns'>);
		return useCampaignActions({
			campaignId,
			// Only the two A/B fields `handleSave` touches are read on this path.
			abTest: {
				abTestEnabled: ref(false),
				buildEnablePayload: () => ({}),
			} as unknown as ABTest,
			campaignData: ref<Doc<'campaigns'> | null>({
				isABTest: false,
			} as unknown as Doc<'campaigns'>),
			isDraft: computed(() => isDraft),
			isScheduled: computed(() => !isDraft),
			validateForm: () => true,
			handleSaveFields: async () => true,
		});
	};

	beforeEach(() => {
		scheduleRuns.length = 0;
		rescheduleRuns.length = 0;
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-10T09:00:00'));
		vi.stubGlobal('useI18n', () => i18n.global);
		vi.stubGlobal('useRouter', () => ({ push: () => {} }));
		vi.stubGlobal('useToast', () => ({ showToast: () => {} }));
		// The send-now path arms an undo window; nothing on the schedule path
		// touches it, but the composable resolves it at setup.
		vi.stubGlobal('useCampaignUndoSend', () => ({ arm: () => {} }));
		// Keyed off the operation LABEL rather than the function reference, so the
		// stub does not have to reach into the generated Convex api object.
		vi.stubGlobal(
			'useBackendOperation',
			(_reference: unknown, options: { label: string | (() => string) }) => ({
				run: async (args: unknown) => {
					// The label is a getter now (it reads the active locale at report
					// time), so resolve it before keying off the English copy.
					const label = typeof options.label === 'function' ? options.label() : options.label;
					if (label === 'Schedule campaign') scheduleRuns.push(args);
					else if (label === 'Reschedule campaign') rescheduleRuns.push(args);
					return {};
				},
			})
		);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('refuses inline a start that was future at edit time and is past at submit', async () => {
		const actions = makeActions(true);

		// 09:00 — the operator picks 09:05 and the computed evaluates as future.
		// The two refs are set the way the `<input type="date">` / `<input
		// type="time">` controls set them, so the fixture does not depend on how
		// an epoch happens to serialise into them.
		actions.scheduledDate.value = '2026-03-10';
		actions.scheduledTime.value = '09:05';
		expect(actions.scheduledStartAt.value).not.toBeNull();

		// 09:10 — the controls were never touched again, so the computed still
		// holds the stale non-null. Submitting must NOT trust it.
		vi.setSystemTime(new Date('2026-03-10T09:10:00'));
		expect(actions.scheduledStartAt.value).not.toBeNull();

		await actions.handleSchedule();

		expect(actions.saveError.value).toBe('Scheduled time must be in the future');
		expect(scheduleRuns).toEqual([]);
		expect(rescheduleRuns).toEqual([]);
	});

	it('still refuses inline on the reschedule path', async () => {
		const actions = makeActions(false);
		actions.scheduledDate.value = '2026-03-10';
		actions.scheduledTime.value = '09:05';
		vi.setSystemTime(new Date('2026-03-10T09:10:00'));

		await actions.handleSchedule();

		expect(actions.saveError.value).toBe('Scheduled time must be in the future');
		expect(rescheduleRuns).toEqual([]);
	});

	it('persists the still-future start unchanged when the clock has not passed it', async () => {
		const actions = makeActions(true);
		// Local-time parse on both sides, so the expected instant matches whatever
		// `parseScheduledStart` produces in the runner's zone.
		const startsAt = new Date('2026-03-10T09:05:00').getTime();
		actions.scheduledDate.value = '2026-03-10';
		actions.scheduledTime.value = '09:05';

		vi.setSystemTime(new Date('2026-03-10T09:04:00'));
		await actions.handleSchedule();

		expect(actions.saveError.value).toBe('');
		expect(scheduleRuns).toEqual([
			{
				campaignId: 'campaign_1',
				scheduledAt: startsAt,
				useRecipientTimezone: false,
				scheduledHour: undefined,
				scheduledMinute: undefined,
			},
		]);
	});

	it('keeps the unset-controls message ahead of the past-start one', async () => {
		const actions = makeActions(true);

		await actions.handleSchedule();

		expect(actions.saveError.value).toBe('Please select a date and time for scheduling');
		expect(scheduleRuns).toEqual([]);
	});
});

/**
 * `reschedule` runs the same pre-flight as `schedule`, so moving a scheduled
 * campaign's start can be refused for capacity. That refusal is an offer, not
 * a fault: the editor claims it into `capacitySchedule` (the panel the edit
 * page renders) exactly as the draft `schedule` path does, instead of a toast.
 */
describe('useCampaignActions reschedule capacity refusal', () => {
	const PLAN = {
		days: 5,
		slices: [0, 100, 200, 200, 100],
		finishesAt: new Date('2026-03-15T00:00:00').getTime(),
		covered: 600,
		truncated: false,
		audienceUnderCounted: false,
	};
	const claimedBy: string[] = [];

	beforeEach(() => {
		claimedBy.length = 0;
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-10T09:00:00'));
		vi.stubGlobal('useI18n', () => i18n.global);
		vi.stubGlobal('useRouter', () => ({ push: () => {} }));
		vi.stubGlobal('useToast', () => ({ showToast: () => {} }));
		vi.stubGlobal('useCampaignUndoSend', () => ({ arm: () => {} }));
		// Every operation fails with the capacity refusal the backend throws, and
		// hands it to the caller's `onError` the way `useBackendOperation` does.
		vi.stubGlobal(
			'useBackendOperation',
			(
				_reference: unknown,
				options: {
					label: string | (() => string);
					onError?: (error: OperationError) => boolean;
				}
			) => ({
				run: async () => {
					const label = typeof options.label === 'function' ? options.label() : options.label;
					const error: OperationError = {
						category: 'invalid_state',
						message: 'This campaign is larger than your sending capacity allows in one go.',
						data: { reason: 'exceeds_sending_capacity', capacityPlan: PLAN },
					};
					if (options.onError?.(error) === true) claimedBy.push(label);
					return { ok: false };
				},
			})
		);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('claims the refusal into capacitySchedule instead of a toast', async () => {
		const actions = useCampaignActions({
			campaignId: ref('campaign_1' as Id<'campaigns'>),
			abTest: {
				abTestEnabled: ref(false),
				buildEnablePayload: () => ({}),
			} as unknown as ABTest,
			campaignData: ref<Doc<'campaigns'> | null>({
				isABTest: false,
			} as unknown as Doc<'campaigns'>),
			isDraft: computed(() => false),
			isScheduled: computed(() => true),
			validateForm: () => true,
			handleSaveFields: async () => true,
		});
		actions.scheduledDate.value = '2026-03-10';
		actions.scheduledTime.value = '10:00';

		await actions.handleSchedule();

		expect(claimedBy).toEqual(['Reschedule campaign']);
		expect(actions.capacitySchedule.value).toEqual(PLAN);
		expect(actions.saveError.value).toBe('');
	});
});
