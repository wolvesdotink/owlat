<script setup lang="ts">
import { api } from '@owlat/api';
import { isValidEmail } from '@owlat/shared';
import { needsSendConfirmation, SEND_UNDO_WINDOW_MS } from '~/lib/campaignSend';
import type { ReviewCampaignData, ReviewSchedule } from '~/lib/campaignCompose';
import { readStoredBlocks } from '~/lib/presendChecks/blockLocator';
import { sendTimingFromCampaign, sendTimingScheduleArgs, type SendTiming } from '~/lib/sendTiming';
import ReviewSendOptions from '~/components/campaigns/steps/review/ReviewSendOptions.vue';
import ReviewSummary from '~/components/campaigns/steps/review/ReviewSummary.vue';

type SendOption = 'now' | 'later';

interface Props {
	data: ReviewCampaignData;
	/** A "Schedule for later" choice made before a trip to the email editor. */
	initialSchedule?: ReviewSchedule | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{
	back: [];
	editStep: [step: string];
	complete: [];
	retryTemplates: [];
	/**
	 * Open the email editor; the schedule comes back with the return link. With
	 * a Block id the editor opens with that Block selected (pre-send "Show me").
	 */
	editEmail: [schedule: ReviewSchedule | null, blockId?: string];
}>();

const router = useRouter();
const { showToast } = useToast();
const { t, locale } = useI18n();

// Send options
const sendOption = ref<SendOption>(props.initialSchedule ? 'later' : 'now');
const scheduledDate = ref(props.initialSchedule?.date ?? '');
const scheduledTime = ref(props.initialSchedule?.time ?? '');
// How each recipient's delivery time is picked: one instant, their local
// time, or optimized per contact (`~/lib/sendTiming`).
const timing = ref<SendTiming>(
	sendTimingFromCampaign({
		useRecipientTimezone: props.initialSchedule?.recipientTimezone,
		sendTimeOptimization: props.initialSchedule?.optimization,
	})
);

const handleEditEmail = (blockId?: string) => {
	const schedule =
		sendOption.value === 'later'
			? {
					date: scheduledDate.value,
					time: scheduledTime.value,
					recipientTimezone: timing.value.mode === 'local',
					...(timing.value.mode === 'optimized'
						? {
								optimization: {
									windowHours: timing.value.windowHours,
									holdoutPercent: timing.value.holdoutPercent,
								},
							}
						: {}),
				}
			: null;
	if (blockId) emit('editEmail', schedule, blockId);
	else emit('editEmail', schedule);
};

// Test email modal
const isTestEmailModalOpen = ref(false);

// Send confirmation, scaled to blast radius: a small list sends on one click,
// a real audience has to be confirmed by name and by number first.
const isSendConfirmOpen = ref(false);
const numberFormat = computed(() => new Intl.NumberFormat(locale.value));
const audienceCountLabel = computed(
	() =>
		`${numberFormat.value.format(props.data.audienceCount ?? 0)}${props.data.audienceCountAtLeast ? '+' : ''}`
);
/** The size a decision may be taken on: `null` (unknown) for a lower bound. */
const decisionAudienceCount = computed(() =>
	props.data.audienceCountAtLeast ? null : props.data.audienceCount
);
const undoWindowSeconds = Math.round(SEND_UNDO_WINDOW_MS / 1000);

/** The 60s undo window only covers an immediate send; a date is its own undo. */
const requiresSendConfirmation = computed(
	() => sendOption.value === 'now' && needsSendConfirmation(decisionAudienceCount.value)
);

// The undo window the send is held for, armed here and counted down by the
// toast on the report page this step navigates to.
const { arm: armUndoSend } = useCampaignUndoSend();

/**
 * Pre-flight refused the send and handed back the multi-day schedule it would
 * take instead. Capacity is a SCHEDULE, not a failure, so
 * the refusal is claimed here and rendered as a calm panel rather than
 * left to the generic red `invalid_state` toast.
 */
const { capacitySchedule, claimCapacityRefusal, dismissCapacitySchedule } = useCapacityRefusal();

// Mutations. There is deliberately no `sendNow` here: "send now" schedules the
// campaign one undo window out instead, so the send is a real, cancellable
// scheduled campaign rather than a fire-and-forget the operator cannot recall.
const { run: scheduleCampaign } = useBackendOperation(api.campaigns.scheduling.schedule, {
	label: () => t('components.campaigns.steps.reviewStep.scheduleOperation'),
	onError: claimCapacityRefusal,
});

// Modal state — `error`/`setError` carry the send-blocked reason and local
// schedule validation; `isLoading` gates the button. Backend errors are
// surfaced by the operation module.
const { isLoading, error, setError, setLoading } = useModal();

const { data: domainVerificationStatus } = useOrganizationQuery(
	api.domains.domains.getEmailDomainVerificationStatus,
	() => {
		const email = props.data.fromEmail.trim();
		if (!email || !isValidEmail(email)) return undefined;
		return { email };
	}
);

// TODAY'S HEADROOM, shown with the send options rather than after the send is
// attempted. Same paced projection the binding gate meters against
// (`campaigns/sendingReadiness.ts`), so this line and a capacity refusal can
// never quote different numbers.
const { data: sendingReadiness } = useOrganizationQuery(
	api.campaigns.sendingReadiness.getSendingReadiness,
	() => {
		const from = props.data.fromEmail.trim();
		return isValidEmail(from) ? { fromEmail: from } : {};
	}
);

const sendBlockedReason = computed(() => {
	// The send pipeline refuses an email without HTML; say so here, not after
	// the click.
	if (props.data.emailBodyHtml === null) {
		return t('components.campaigns.steps.reviewStep.blocked.emptyBody');
	}

	const status = domainVerificationStatus.value;
	if (!status) return null;

	if (!status.exists) {
		return t('components.campaigns.steps.reviewStep.blocked.domainMissing', {
			domain: status.domain,
		});
	}

	if (!status.verified) {
		return t('components.campaigns.steps.reviewStep.blocked.domainUnverified', {
			domain: status.domain,
		});
	}

	return null;
});

// PRE-SEND CHECKS on the email as it will go out: size, links, images,
// contrast, the MTA's content screening, the unsubscribe and postal-address
// rules. They run on arrival and again whenever the HTML, subject or sender
// changes. Only the refusal above blocks; every check warns, and the send
// button says "Send anyway" until the current warnings are marked as reviewed.
const presendSource = computed(() => {
	const html = props.data.emailBodyHtml;
	if (!html) return null;
	return {
		html,
		blocks: readStoredBlocks(props.data.emailContent),
		subject: props.data.campaignSubject,
		fromEmail: props.data.fromEmail.trim(),
		...(props.data.audienceKind ? { audienceKind: props.data.audienceKind } : {}),
		blockedReason: sendBlockedReason.value,
	};
});
const {
	checks: presendChecks,
	summary: presendSummary,
	isChecking: isPresendChecking,
	run: runPresendChecks,
} = usePresendChecks(() => presendSource.value);
watch(
	() => presendSource.value !== null,
	(ready) => {
		if (ready) void runPresendChecks();
	},
	{ immediate: true }
);
/** The warnings the sender marked as reviewed; a new warning un-reviews them. */
const reviewedWarnings = ref<string | null>(null);
const warningsReviewed = computed(
	() =>
		presendSummary.value.warnings === 0 || reviewedWarnings.value === presendSummary.value.signature
);

// Validation
const validate = (): boolean => {
	if (sendOption.value === 'later') {
		if (!scheduledDate.value) {
			setError(t('components.campaigns.steps.reviewStep.errors.dateRequired'));
			return false;
		}

		if (!scheduledTime.value) {
			setError(t('components.campaigns.steps.reviewStep.errors.timeRequired'));
			return false;
		}

		const scheduledDateTime = new Date(`${scheduledDate.value}T${scheduledTime.value}`);
		if (scheduledDateTime.getTime() <= Date.now()) {
			setError(t('components.campaigns.steps.reviewStep.errors.timeInPast'));
			return false;
		}
	}

	return true;
};

/**
 * The send itself, past every gate. Both options end the same way: on the
 * campaign's report, which is the thing the operator actually wants to look at
 * once the scary button is pressed.
 */
const submitSend = async () => {
	dismissCapacitySchedule();
	setLoading(true);
	try {
		if (sendOption.value === 'now') {
			// Held one undo window out rather than sent, so the toast on the report
			// has something real to cancel. Timezone staggering is meaningless for
			// an immediate send, so it is explicitly off.
			const sendAt = Date.now() + SEND_UNDO_WINDOW_MS;
			const result = await scheduleCampaign({
				campaignId: props.data.campaignId,
				scheduledAt: sendAt,
				useRecipientTimezone: false,
			});
			if (!result.ok) return;

			armUndoSend({
				campaignId: props.data.campaignId,
				campaignName: props.data.campaignName,
				sendAt,
			});
		} else {
			const scheduledDateTime = new Date(`${scheduledDate.value}T${scheduledTime.value}`);

			const result = await scheduleCampaign({
				campaignId: props.data.campaignId,
				scheduledAt: scheduledDateTime.getTime(),
				...sendTimingScheduleArgs(timing.value, scheduledDateTime),
			});
			if (!result.ok) return;

			showToast(
				timing.value.mode === 'local'
					? t('components.campaigns.steps.reviewStep.toast.scheduledPerTimezone', {
							time: scheduledTime.value,
						})
					: timing.value.mode === 'optimized'
						? t('components.campaigns.steps.reviewStep.toast.scheduledOptimized')
						: t('components.campaigns.steps.reviewStep.toast.scheduled')
			);
		}

		// Before navigating: the wizard clears its unsaved-changes flag on this.
		emit('complete');
		router.push(`/dashboard/campaigns/${props.data.campaignId}/report`);
	} finally {
		setLoading(false);
	}
};

// Handle campaign send
const handleSendCampaign = async () => {
	if (sendBlockedReason.value) {
		setError(sendBlockedReason.value);
		return;
	}

	if (!validate()) return;

	if (requiresSendConfirmation.value) {
		isSendConfirmOpen.value = true;
		return;
	}

	await submitSend();
};

const handleConfirmSend = async () => {
	isSendConfirmOpen.value = false;
	await submitSend();
};
</script>

<template>
	<div class="space-y-6">
		<!-- Campaign Summary Card -->
		<div class="card p-6">
			<div class="mb-6">
				<h2 class="text-xl font-semibold text-text-primary">
					{{ t('components.campaigns.steps.reviewStep.title') }}
				</h2>
				<p class="text-text-secondary mt-1">
					{{ t('components.campaigns.steps.reviewStep.subtitle') }}
				</p>
			</div>

			<!-- Error Alert -->
			<UiErrorAlert v-if="error" :message="error" class="mb-6" />

			<CampaignsCapacitySchedulePanel
				v-if="capacitySchedule"
				:plan="capacitySchedule"
				class="mb-6"
			/>

			<!-- Campaign Details Summary -->
			<ReviewSummary
				:data="data"
				:audience-count-label="audienceCountLabel"
				@edit-step="emit('editStep', $event)"
				@edit-email="handleEditEmail()"
				@retry-templates="emit('retryTemplates')"
			/>
		</div>

		<CampaignsPresendChecksPanel
			v-if="presendSource"
			:checks="presendChecks"
			:summary="presendSummary"
			:is-checking="isPresendChecking"
			acknowledgeable
			:acknowledged="warningsReviewed"
			@retry="runPresendChecks"
			@acknowledge="reviewedWarnings = presendSummary.signature"
			@show-block="handleEditEmail"
		/>

		<!--
			Test Email Section — ABOVE the send controls, because sending a test is
			the step before the real send, not a footnote after it.
		-->
		<div class="card p-6">
			<div class="flex items-center justify-between">
				<div>
					<h3 class="text-lg font-semibold text-text-primary">
						{{ t('components.campaigns.steps.reviewStep.testEmailTitle') }}
					</h3>
					<p class="text-sm text-text-secondary mt-1">
						{{ t('components.campaigns.steps.reviewStep.testEmailDescription') }}
					</p>
				</div>
				<UiButton variant="secondary" @click="isTestEmailModalOpen = true">
					<template #iconLeft><Icon name="lucide:send-horizonal" class="w-4 h-4" /></template>
					{{ t('components.campaigns.steps.reviewStep.sendTest') }}
				</UiButton>
			</div>
		</div>

		<!-- Send Options Card -->
		<ReviewSendOptions
			v-model:send-option="sendOption"
			v-model:scheduled-date="scheduledDate"
			v-model:scheduled-time="scheduledTime"
			v-model:timing="timing"
			:campaign-id="data.campaignId"
			:is-ab-test="data.abTestEnabled"
			:send-blocked-reason="sendBlockedReason"
			:readiness="sendingReadiness"
			:audience-size="decisionAudienceCount"
		/>

		<!-- Actions -->
		<div class="flex items-center justify-between pt-2">
			<UiButton variant="secondary" @click="emit('back')">
				<template #iconLeft><Icon name="lucide:arrow-left" class="w-4 h-4" /></template>
				{{ t('common.back') }}
			</UiButton>
			<UiButton
				:loading="isLoading"
				:disabled="
					isLoading ||
					Boolean(sendBlockedReason) ||
					(sendOption === 'later' && (!scheduledDate || !scheduledTime))
				"
				@click="handleSendCampaign"
			>
				<template v-if="!isLoading" #iconLeft><Icon name="lucide:send" class="w-4 h-4" /></template>
				{{
					isLoading
						? sendOption === 'now'
							? t('components.campaigns.steps.reviewStep.sending')
							: t('components.campaigns.steps.reviewStep.scheduling')
						: !warningsReviewed
							? sendOption === 'now'
								? t('components.campaigns.steps.reviewStep.sendAnyway')
								: t('components.campaigns.steps.reviewStep.scheduleAnyway')
							: sendOption === 'now'
								? t('components.campaigns.steps.reviewStep.sendCampaign')
								: t('components.campaigns.steps.reviewStep.scheduleCampaign')
				}}
			</UiButton>
		</div>

		<!--
			Send confirmation — only for an audience big enough to earn the
			interruption. It names the campaign and the number, because "are you
			sure?" without them is a click-through, not a decision.
		-->
		<UiConfirmationDialog
			v-model:open="isSendConfirmOpen"
			variant="warning"
			:title="
				t('components.campaigns.steps.reviewStep.sendConfirm.title', {
					count: audienceCountLabel,
				})
			"
			:description="
				t('components.campaigns.steps.reviewStep.sendConfirm.description', {
					name: data.campaignName,
					seconds: undoWindowSeconds,
				})
			"
			:confirm-text="t('components.campaigns.steps.reviewStep.sendConfirm.confirm')"
			:cancel-text="t('components.campaigns.steps.reviewStep.sendConfirm.cancel')"
			:is-loading="isLoading"
			@confirm="handleConfirmSend"
		/>

		<!-- Test Email Modal -->
		<CampaignsTestEmailModal
			v-model:open="isTestEmailModalOpen"
			:campaign-id="data.campaignId"
			:subject="data.campaignSubject"
			:from-name="data.fromName"
			:from-email="data.fromEmail"
		/>
	</div>
</template>
