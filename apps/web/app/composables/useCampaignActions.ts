import { ref, type Ref, type ComputedRef } from 'vue';
import { api } from '@owlat/api';
import type { Id, Doc } from '@owlat/api/dataModel';
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
	const { showToast } = useToast();

	// Mutations
	const { run: sendCampaignNow } = useBackendOperation(api.campaigns.campaigns.sendNow, {
		label: 'Send campaign now',
	});
	const { run: scheduleCampaign } = useBackendOperation(api.campaigns.scheduling.schedule, {
		label: 'Schedule campaign',
	});
	const { run: rescheduleCampaign } = useBackendOperation(api.campaigns.scheduling.reschedule, {
		label: 'Reschedule campaign',
	});
	const { run: unscheduleCampaign } = useBackendOperation(api.campaigns.scheduling.unschedule, {
		label: 'Unschedule campaign',
	});
	const { run: cancelCampaign } = useBackendOperation(api.campaigns.scheduling.cancel, {
		label: 'Cancel campaign',
	});
	const { run: enableABTest } = useBackendOperation(api.campaigns.abTest.enableABTest, {
		label: 'Enable A/B test',
	});
	const { run: disableABTest } = useBackendOperation(api.campaigns.abTest.disableABTest, {
		label: 'Disable A/B test',
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
				if ((await enableABTest(abTest.buildEnablePayload(campaignId.value))) === undefined) {
					return false;
				}
			} else if (campaignData.value?.isABTest) {
				if ((await disableABTest({ campaignId: campaignId.value })) === undefined) {
					return false;
				}
			}

			showToast('Campaign saved successfully!');
			onSaved?.();
			return true;
		} finally {
			isSaving.value = false;
		}
	};

	// Send now. Each step aborts the sequence on failure; the failing `run`
	// (or handleSave) has already surfaced the categorized error.
	const executeSendNow = async () => {
		if (!campaignId.value) return;

		isSaving.value = true;
		saveError.value = '';

		try {
			if (isDraft.value) {
				if (!(await handleSave())) return;
			}

			if (isScheduled.value) {
				if ((await unscheduleCampaign({ campaignId: campaignId.value })) === undefined) return;
			}

			if ((await sendCampaignNow({ campaignId: campaignId.value })) === undefined) return;

			showToast('Campaign is now sending!');

			onSaved?.();
			setTimeout(() => {
				router.push('/dashboard/campaigns');
			}, 1500);
		} finally {
			isSaving.value = false;
		}
	};

	const handleSendNow = async () => {
		if (!validateForm() || !campaignId.value) return;
		await executeSendNow();
	};

	// Schedule
	const executeSchedule = async () => {
		if (!campaignId.value) return;

		const scheduledDateTime = new Date(`${scheduledDate.value}T${scheduledTime.value}`);

		isSaving.value = true;
		saveError.value = '';

		try {
			if (isDraft.value) {
				if (!(await handleSave())) return;
				if (
					(await scheduleCampaign({
						campaignId: campaignId.value,
						scheduledAt: scheduledDateTime.getTime(),
						useRecipientTimezone: useRecipientTimezone.value,
						scheduledHour: useRecipientTimezone.value ? scheduledDateTime.getHours() : undefined,
						scheduledMinute: useRecipientTimezone.value
							? scheduledDateTime.getMinutes()
							: undefined,
					})) === undefined
				) {
					return;
				}
			} else if (isScheduled.value) {
				if (
					(await rescheduleCampaign({
						campaignId: campaignId.value,
						scheduledAt: scheduledDateTime.getTime(),
						useRecipientTimezone: useRecipientTimezone.value,
						scheduledHour: useRecipientTimezone.value ? scheduledDateTime.getHours() : undefined,
						scheduledMinute: useRecipientTimezone.value
							? scheduledDateTime.getMinutes()
							: undefined,
					})) === undefined
				) {
					return;
				}
			}

			showToast(
				useRecipientTimezone.value
					? `Campaign scheduled for ${scheduledTime.value} in each recipient's timezone!`
					: 'Campaign scheduled successfully!'
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
			saveError.value = 'Please select a date and time for scheduling';
			return;
		}

		const scheduledDateTime = new Date(`${scheduledDate.value}T${scheduledTime.value}`);
		if (scheduledDateTime.getTime() <= Date.now()) {
			saveError.value = 'Scheduled time must be in the future';
			return;
		}

		await executeSchedule();
	};

	// Unschedule
	const handleUnschedule = async () => {
		if (!campaignId.value || !isScheduled.value) return;

		isSaving.value = true;
		saveError.value = '';

		try {
			const result = await unscheduleCampaign({ campaignId: campaignId.value });
			if (result === undefined) return;
			showToast('Campaign unscheduled. You can now edit it.');
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
			if ((await cancelCampaign({ campaignId: campaignId.value })) === undefined) return;

			showToast('Campaign cancelled.');

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
		useRecipientTimezone,
		initializeSchedule,
		handleSave,
		handleSendNow,
		handleSchedule,
		handleUnschedule,
		handleCancel,
		handleBack,
	};
}
