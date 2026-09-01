import { computed, ref, type Ref, type ComputedRef } from 'vue';
import { api } from '@owlat/api';
import type { Id, Doc } from '@owlat/api/dataModel';
import { parseScheduledStart } from '~/lib/campaignSchedule';
import { SEND_UNDO_WINDOW_MS } from '~/lib/campaignSend';
import { useCapacityRefusal } from './useCapacityRefusal';
import type { useCampaignABTest } from './useCampaignABTest';

type ABTest = ReturnType<typeof useCampaignABTest>;

export interface CampaignActionsOptions {
	campaignId: Ref<Id<'campaigns'>>;
	abTest: ABTest;
	campaignData: Ref<Doc<'campaigns'> | null | undefined>;
	isDraft: ComputedRef<boolean>;
	isScheduled: ComputedRef<boolean>;
	validateForm: () => boolean;
	/** Saves the form fields; resolves to whether all field-save mutations succeeded. */
	handleSaveFields: () => Promise<boolean>;
	/**
	 * Called once a successful save/schedule/send has persisted the form, right
	 * before any navigation away. Lets the caller clear its unsaved-changes flag
	 * so the route guard doesn't prompt after a successful action.
	 */
	onSaved?: () => void;
}

/**
 * Composable for campaign action handlers: save, send, schedule, unschedule, cancel.
 */
export function useCampaignActions(options: CampaignActionsOptions) {
	const {
		campaignId,
		abTest,
		campaignData,
		isDraft,
		isScheduled,
		validateForm,
		handleSaveFields,
		onSaved,
	} = options;
	const router = useRouter();
	const { t } = useI18n();
	const { showToast } = useToast();

	/**
	 * The multi-day schedule pre-flight handed back instead of starting the
	 * campaign, or `null`. NOT an error state: capacity is a schedule, and the
	 * caller renders it as one (deliverability plan D14).
	 */
	const { capacitySchedule, claimCapacityRefusal, dismissCapacitySchedule } = useCapacityRefusal();

	// The undo window a "send now" is held for, armed here and counted down by
	// the toast on the report page.
	const { arm: armUndoSend } = useCampaignUndoSend();

	// Mutations. No `sendNow`: see `executeSendNow` — an immediate send is a
	// schedule one undo window out, which is the same mutation as any other
	// schedule.
	const { run: scheduleCampaign } = useBackendOperation(api.campaigns.scheduling.schedule, {
		label: () => t('shared.useCampaignActions.operations.schedule'),
		onError: claimCapacityRefusal,
	});
	// No `onError` claim here, deliberately: `campaigns.scheduling.reschedule`
	// does not run pre-flight (only `schedule` does), so it cannot refuse for
	// capacity and the handler could only ever return false. Whether rescheduling
	// should also run the capacity gate is a separate decision.
	const { run: rescheduleCampaign } = useBackendOperation(api.campaigns.scheduling.reschedule, {
		label: () => t('shared.useCampaignActions.operations.reschedule'),
	});
	const { run: unscheduleCampaign } = useBackendOperation(api.campaigns.scheduling.unschedule, {
		label: () => t('shared.useCampaignActions.operations.unschedule'),
	});
	const { run: cancelCampaign } = useBackendOperation(api.campaigns.scheduling.cancel, {
		label: () => t('shared.useCampaignActions.operations.cancel'),
	});
	const { run: enableABTest } = useBackendOperation(api.campaigns.abTest.enableABTest, {
		label: () => t('shared.useCampaignActions.operations.enableABTest'),
	});
	const { run: disableABTest } = useBackendOperation(api.campaigns.abTest.disableABTest, {
		label: () => t('shared.useCampaignActions.operations.disableABTest'),
	});

	// State
	const isSaving = ref(false);
	const saveError = ref('');

	// Schedule state
	const scheduledDate = ref('');
	const scheduledTime = ref('');
	// When enabled, the campaign is staggered so each recipient receives it at the
	// chosen wall-clock time in their own timezone (mirrors the wizard Review step).
	// Honored by both the draft `schedule` and the `reschedule` path.
	const useRecipientTimezone = ref(false);

	/**
	 * The chosen send start as epoch ms for the capacity PREVIEW, or `null` when
	 * it is unset, unparseable or already past.
	 *
	 * Reactive on the two form controls only: `Date.now()` is not a tracked
	 * dependency, so this value is the parse as of the last edit of the date or
	 * time, not as of the moment it is read. That is exactly right for a preview
	 * (it must stay a `computed` so `useOrganizationQuery` re-runs when the
	 * controls change, and a few minutes of clock staleness changes no answer it
	 * gives), and exactly wrong for a submit-time past-check — an editor left
	 * open past the chosen instant would still see a cached non-null. The submit
	 * path therefore calls {@link parseScheduledStart} itself with a live clock;
	 * the derivation is still the one in `campaignSchedule.ts`.
	 */
	const scheduledStartAt = computed<number | null>(() =>
		parseScheduledStart(scheduledDate.value, scheduledTime.value, Date.now())
	);

	const initializeSchedule = (scheduledAt: number | undefined, recipientTimezone?: boolean) => {
		if (scheduledAt) {
			const date = new Date(scheduledAt);
			scheduledDate.value = date.toISOString().slice(0, 10);
			scheduledTime.value = date.toTimeString().slice(0, 5);
		}
		// Seed the toggle from the campaign so rescheduling a timezone-staggered
		// campaign keeps the option on (and lets the user turn it off).
		useRecipientTimezone.value = recipientTimezone ?? false;
	};

	// Save campaign. Returns whether the save (fields + A/B test) fully
	// succeeded so multi-step callers can abort the rest of their sequence.
	const handleSave = async (): Promise<boolean> => {
		if (!validateForm() || !campaignId.value) return false;

		isSaving.value = true;
		saveError.value = '';

		try {
			if (!(await handleSaveFields())) return false;

			// Update A/B test settings
			if (abTest.abTestEnabled.value) {
				if (!(await enableABTest(abTest.buildEnablePayload(campaignId.value))).ok) {
					return false;
				}
			} else if (campaignData.value?.isABTest) {
				if (!(await disableABTest({ campaignId: campaignId.value })).ok) {
					return false;
				}
			}

			showToast(t('shared.useCampaignActions.toasts.saved'));
			onSaved?.();
			return true;
		} finally {
			isSaving.value = false;
		}
	};

	// Send now. Each step aborts the sequence on failure; the failing `run`
	// (or handleSave) has already surfaced the categorized error.
	//
	// "Now" means one undo window from now: the campaign is SCHEDULED at
	// `Date.now() + SEND_UNDO_WINDOW_MS` rather than handed to `sendNow`, so the
	// one irreversible action in the product has a minute in which it is still a
	// scheduled campaign anybody can call back (CampaignsUndoSendToast, mounted
	// on the report this lands on). The server contract is untouched — the same
	// `schedule` mutation, the same pre-flight, the same cancel path.
	const executeSendNow = async () => {
		if (!campaignId.value) return;

		isSaving.value = true;
		saveError.value = '';
		dismissCapacitySchedule();

		try {
			if (isDraft.value) {
				if (!(await handleSave())) return;
			}

			// `schedule` only accepts a draft, so a campaign that is already
			// scheduled goes back to draft first — the same step the immediate send
			// took, for the same reason.
			if (isScheduled.value) {
				if (!(await unscheduleCampaign({ campaignId: campaignId.value })).ok) return;
			}

			const sendAt = Date.now() + SEND_UNDO_WINDOW_MS;
			if (
				!(
					await scheduleCampaign({
						campaignId: campaignId.value,
						scheduledAt: sendAt,
						// Staggering by recipient timezone is a scheduling choice; an
						// immediate send is not one, whatever the form's toggle says.
						useRecipientTimezone: false,
					})
				).ok
			) {
				return;
			}

			armUndoSend({
				campaignId: campaignId.value,
				campaignName: campaignData.value?.name ?? '',
				sendAt,
			});

			onSaved?.();
			// Straight to the report: it is where the undo toast lives and where the
			// numbers start climbing, which is the point of having pressed send.
			router.push(`/dashboard/campaigns/${campaignId.value}/report`);
		} finally {
			isSaving.value = false;
		}
	};

	const handleSendNow = async () => {
		if (!validateForm() || !campaignId.value) return;
		await executeSendNow();
	};

	// Schedule
	// `startsAt` is passed in rather than read off `scheduledStartAt` so the
	// persisted instant is the one `handleSchedule` validated against a LIVE
	// clock at click time.
	const executeSchedule = async (startsAt: number) => {
		if (!campaignId.value) return;

		// Only the wall-clock hour/minute is read off this Date; the persisted
		// instant is `startsAt` itself.
		const scheduledDateTime = new Date(startsAt);

		isSaving.value = true;
		saveError.value = '';
		dismissCapacitySchedule();

		try {
			if (isDraft.value) {
				if (!(await handleSave())) return;
				if (
					!(
						await scheduleCampaign({
							campaignId: campaignId.value,
							scheduledAt: scheduledDateTime.getTime(),
							useRecipientTimezone: useRecipientTimezone.value,
							scheduledHour: useRecipientTimezone.value ? scheduledDateTime.getHours() : undefined,
							scheduledMinute: useRecipientTimezone.value
								? scheduledDateTime.getMinutes()
								: undefined,
						})
					).ok
				) {
					return;
				}
			} else if (isScheduled.value) {
				if (
					!(
						await rescheduleCampaign({
							campaignId: campaignId.value,
							scheduledAt: scheduledDateTime.getTime(),
							useRecipientTimezone: useRecipientTimezone.value,
							scheduledHour: useRecipientTimezone.value ? scheduledDateTime.getHours() : undefined,
							scheduledMinute: useRecipientTimezone.value
								? scheduledDateTime.getMinutes()
								: undefined,
						})
					).ok
				) {
					return;
				}
			}

			showToast(
				useRecipientTimezone.value
					? t('shared.useCampaignActions.toasts.scheduledRecipientTimezone', {
							time: scheduledTime.value,
						})
					: t('shared.useCampaignActions.toasts.scheduled')
			);

			onSaved?.();
			setTimeout(() => {
				router.push('/dashboard/campaigns');
			}, 1500);
		} finally {
			isSaving.value = false;
		}
	};

	const handleSchedule = async () => {
		if (!validateForm() || !campaignId.value) return;

		if (!scheduledDate.value || !scheduledTime.value) {
			saveError.value = t('shared.useCampaignActions.errors.scheduleDateTimeRequired');
			return;
		}

		// Derived here with a live clock, not read off the preview computed: a
		// start that was future when the controls were last touched may be past
		// by the time the operator presses the button.
		const startsAt = parseScheduledStart(scheduledDate.value, scheduledTime.value, Date.now());
		if (startsAt === null) {
			saveError.value = t('shared.useCampaignActions.errors.scheduleInFuture');
			return;
		}

		await executeSchedule(startsAt);
	};

	// Unschedule
	const handleUnschedule = async () => {
		if (!campaignId.value || !isScheduled.value) return;

		isSaving.value = true;
		saveError.value = '';

		try {
			const result = await unscheduleCampaign({ campaignId: campaignId.value });
			if (!result.ok) return;
			showToast(t('shared.useCampaignActions.toasts.unscheduled'));
		} finally {
			isSaving.value = false;
		}
	};

	// Cancel
	const handleCancel = async () => {
		if (!campaignId.value || !isScheduled.value) return;

		isSaving.value = true;
		saveError.value = '';

		try {
			if (!(await cancelCampaign({ campaignId: campaignId.value })).ok) return;

			showToast(t('shared.useCampaignActions.toasts.cancelled'));

			onSaved?.();
			setTimeout(() => {
				router.push('/dashboard/campaigns');
			}, 1500);
		} finally {
			isSaving.value = false;
		}
	};

	// Navigation
	const handleBack = () => {
		router.push('/dashboard/campaigns');
	};

	return {
		isSaving,
		saveError,
		scheduledDate,
		scheduledTime,
		scheduledStartAt,
		useRecipientTimezone,
		initializeSchedule,
		handleSave,
		handleSendNow,
		handleSchedule,
		handleUnschedule,
		handleCancel,
		handleBack,
		capacitySchedule,
		dismissCapacitySchedule,
	};
}
