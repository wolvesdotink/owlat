<script setup lang="ts">
import { openAfterSave, openWithoutSaving } from '~/lib/openAfterSave';
import type { SenderPickerHandle } from '~/utils/campaignSenderPicker';
import { useRecordPaletteObjectOpen } from '~/composables/useCommandPaletteObjectRecents';
import { useCampaignSendCapacity } from '~/composables/campaigns/useCampaignSendCapacity';
import CampaignContentCard from '~/components/campaigns/edit/ContentCard.vue';
import CampaignDetailsCard from '~/components/campaigns/edit/DetailsCard.vue';
import CampaignEditActions from '~/components/campaigns/edit/EditActions.vue';
import CampaignEditHeader from '~/components/campaigns/edit/EditHeader.vue';
import CampaignEditNotices from '~/components/campaigns/edit/EditNotices.vue';
import CampaignPendingReview from '~/components/campaigns/edit/PendingReview.vue';
import CampaignScheduleCard from '~/components/campaigns/edit/ScheduleCard.vue';
import CampaignWarmupCard from '~/components/campaigns/edit/WarmupCard.vue';

const { t, locale } = useI18n();

useHead({ title: () => t('dashboard.campaigns.detail.edit.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Get campaign ID from route
const campaignId = useRouteId<'campaigns'>();

// Initialize composables
const abTest = useCampaignABTest();
// The wizard's sender picker; its validate() guards every save.
const senderPickerRef = ref<SenderPickerHandle | null>(null);

const {
	// Data
	campaignData,
	campaignLoading,
	campaignError,
	refetchCampaign,
	emailTemplates,
	campaignAudience,
	audienceCount,
	audience,

	// Form state
	campaignName,
	fromName,
	fromEmail,
	replyTo,
	selectedTemplateId,
	campaignSubject,
	archiveEnabled,
	scheduledDate,
	scheduledTime,
	scheduledStartAt,
	sendTiming,

	// Computed
	selectedTemplate,
	isScheduled,
	isDraft,
	canEdit,
	templateLanguages,

	// Errors & loading
	errors,
	isSaving,
	saveError,

	// Unsaved-changes guard
	showUnsavedChangesDialog,
	isSavingBeforeLeave,
	hasUnsavedChanges,
	confirmDiscard,
	confirmSave,
	cancelNavigation,
	onSenderPreselected,

	// Actions
	handleSave,
	handleSendNow,
	handleSchedule,
	handleUnschedule,
	handleCancel,
	handleBack,
	capacitySchedule,
	dismissCapacitySchedule,

	// Helpers
	formatDate,
	getMinScheduleDate,
	getLanguageLabel,
} = useCampaignForm(campaignId, abTest, senderPickerRef);
// ⌘K's "Jump back" list remembers the campaign once it has a name.
useRecordPaletteObjectOpen(() =>
	campaignData.value?.name
		? { kind: 'campaign', id: campaignId.value, title: campaignData.value.name }
		: null
);

// The wizard's recipients control, fed by the same composable as the wizard.
const {
	audienceType,
	selectedTopicId,
	selectedSegmentId,
	topics,
	segments,
	audienceLoadFailed,
	retryAudienceLists,
} = campaignAudience;

/** The scheduled send moment, formatted against the active locale. */
const scheduledAtDisplay = computed(() => {
	const at = campaignData.value?.scheduledAt;
	return at ? new Date(at).toLocaleString(locale.value) : '';
});

// Guard the "Edit Email" link. In a browser it opens the linked email editor in
// a NEW tab, so the SPA route guard never fires — intercept the click and, when
// the campaign form has unsaved edits, prompt to save them first (so the
// campaign and its linked email stay consistent) before opening the editor. On
// desktop the link navigates this window instead (the route guard does fire),
// so the prompt's actions clear the dirty state before navigating.
const showEditEmailPrompt = ref(false);
const pendingEmailUrl = ref('');
const onEditEmailClick = (event: MouseEvent, url: string) => {
	if (!hasUnsavedChanges.value) return; // no edits — let it open the new tab
	event.preventDefault();
	pendingEmailUrl.value = url;
	showEditEmailPrompt.value = true;
};
const closeEditEmailPrompt = () => {
	pendingEmailUrl.value = '';
	showEditEmailPrompt.value = false;
};
// Desktop has no tabs: the editor opens in this window instead (lib/openAfterSave).
const { isDesktop } = useDesktopContext();
const discardAndOpenEmail = async () => {
	const url = pendingEmailUrl.value;
	closeEditEmailPrompt();
	if (!url) return;
	await openWithoutSaving({
		url,
		isDesktop: isDesktop.value,
		discard: () => {
			hasUnsavedChanges.value = false;
		},
		navigate: navigateTo,
	});
};
const saveAndOpenEmail = async () => {
	// On failure keep the prompt up (with inline errors) so nothing is lost —
	// handleSave clears the dirty flag only on success.
	const url = pendingEmailUrl.value;
	if (!url) return;
	const opened = await openAfterSave({
		url,
		save: handleSave,
		isDesktop: isDesktop.value,
		navigate: navigateTo,
	});
	if (opened) closeEditEmailPrompt();
};

// Test-email modal (shared CampaignsTestEmailModal owns the send flow)
const isTestEmailModalOpen = ref(false);

// Send-now confirmation — sending to the whole eligible audience is irreversible,
// so gate the one-click button behind an explicit confirm dialog.
const showSendConfirm = ref(false);
const handleConfirmSend = async () => {
	await handleSendNow();
	showSendConfirm.value = false;
};

// Warm-up state, the exact audience size, the send estimate, the capacity plan
// and today's headroom.
const {
	warmingOverview,
	exactAudienceSize,
	audienceCountLabel,
	sendEstimate,
	sendingReadiness,
	shownCapacityPlan,
} = useCampaignSendCapacity({
	audience,
	audienceCount,
	fromEmail,
	scheduledStartAt,
	capacitySchedule,
});
</script>

<template>
	<div class="min-h-full bg-bg-base">
		<CampaignEditHeader
			:campaign="campaignData"
			:is-scheduled="isScheduled"
			:is-draft="isDraft"
			@back="handleBack"
		/>

		<UiQueryBoundary
			:loading="campaignLoading"
			:error="campaignError"
			@retry="refetchCampaign"
			:error-title="t('dashboard.campaigns.detail.edit.errorTitle')"
			:loading-label="t('dashboard.campaigns.detail.edit.loadingLabel')"
		>
			<!-- Not Found State -->
			<div v-if="!campaignData" class="max-w-4xl mx-auto px-6 py-16 text-center">
				<UiIconBox
					icon="lucide:alert-circle"
					size="xl"
					variant="surface"
					rounded="full"
					class="mb-4 mx-auto"
				/>
				<p class="text-text-primary font-medium">
					{{ t('dashboard.campaigns.detail.edit.notFoundTitle') }}
				</p>
				<p class="text-sm text-text-secondary mt-1">
					{{ t('dashboard.campaigns.detail.edit.notFoundDescription') }}
				</p>
				<UiButton variant="secondary" class="mt-6" @click="handleBack">
					{{ t('dashboard.campaigns.detail.edit.backToCampaigns') }}
				</UiButton>
			</div>

			<!-- Cannot Edit State: sending, sent or stopped -->
			<CampaignsCampaignEditLocked
				v-else-if="!canEdit && campaignData.status !== 'pending_review'"
				:campaign-id="campaignId"
				:status="campaignData.status"
				@back="handleBack"
			/>

			<!-- Pending Review State -->
			<CampaignPendingReview
				v-else-if="campaignData.status === 'pending_review'"
				:content-block-reason="campaignData.contentBlockReason"
				@back="handleBack"
			/>

			<!-- Edit Form -->
			<div v-else class="max-w-4xl mx-auto px-6 py-8">
				<div class="space-y-6">
					<CampaignEditNotices
						:content-block-reason="campaignData.contentBlockReason"
						:save-error="saveError"
						:is-scheduled="isScheduled"
						:scheduled-at="campaignData.scheduledAt"
						:scheduled-at-display="scheduledAtDisplay"
						:is-saving="isSaving"
						@unschedule="handleUnschedule"
						@cancel="handleCancel"
					/>

					<CampaignDetailsCard
						v-model:campaign-name="campaignName"
						v-model:reply-to="replyTo"
						:name-error="errors.campaignName"
						:disabled="isScheduled"
					>
						<!-- From: the wizard's curated sender picker (the server refuses
						     any address off that list) -->
						<CampaignsStepsSetupSenderPicker
							ref="senderPickerRef"
							v-model:from-name="fromName"
							v-model:from-email="fromEmail"
							:campaign-id="campaignId"
							:campaign-details="campaignData"
							:disabled="isScheduled"
							@preselected="onSenderPreselected"
						/>
					</CampaignDetailsCard>

					<!-- Recipients: the wizard's one control, with its count and warnings -->
					<CampaignsStepsSetupAudiencePicker
						v-model:audience-type="audienceType"
						v-model:selected-topic-id="selectedTopicId"
						v-model:selected-segment-id="selectedSegmentId"
						:topics="topics ?? null"
						:segments="segments ?? null"
						:audience-count="audienceCount ?? null"
						:error="errors.audience ?? null"
						:load-failed="audienceLoadFailed"
						:disabled="isScheduled"
						@retry="retryAudienceLists"
					/>

					<CampaignContentCard
						v-model:subject="campaignSubject"
						:template="selectedTemplate"
						:content-error="errors.content"
						:subject-error="errors.subject"
						:disabled="isScheduled"
						@edit-email-click="onEditEmailClick"
					/>

					<!-- A/B Testing Card -->
					<CampaignsABTestConfig
						v-if="isDraft"
						v-model:ab-test-enabled="abTest.abTestEnabled.value"
						v-model:ab-test-type="abTest.abTestType.value"
						v-model:ab-variant-b-subject="abTest.abVariantBSubject.value"
						v-model:ab-variant-b-template-id="abTest.abVariantBTemplateId.value"
						v-model:ab-split-percentage="abTest.abSplitPercentage.value"
						v-model:ab-winner-criteria="abTest.abWinnerCriteria.value"
						v-model:ab-test-duration="abTest.abTestDuration.value"
						:campaign-subject="campaignSubject"
						:selected-template-name="selectedTemplate?.name"
						:email-templates="emailTemplates"
						:selected-template-id="selectedTemplateId"
					/>

					<!-- Archive Settings Card -->
					<div class="card p-6">
						<div class="flex items-center justify-between gap-4">
							<div class="min-w-0">
								<h3 class="text-lg font-semibold text-text-primary">
									{{ t('dashboard.campaigns.detail.edit.archive.title') }}
								</h3>
								<p class="text-sm text-text-secondary mt-1">
									{{ t('dashboard.campaigns.detail.edit.archive.description') }}
								</p>
							</div>
							<UiSwitch
								v-model="archiveEnabled"
								class="shrink-0"
								:disabled="isScheduled"
								:label="t('dashboard.campaigns.detail.edit.archive.switchLabel')"
							/>
						</div>
					</div>

					<CampaignScheduleCard
						v-model:scheduled-date="scheduledDate"
						v-model:scheduled-time="scheduledTime"
						v-model:send-timing="sendTiming"
						:is-scheduled="isScheduled"
						:campaign-id="campaignId"
						:start-at="scheduledStartAt"
						:is-ab-test="abTest.abTestEnabled.value"
						:min-date="getMinScheduleDate()"
						:format-date="formatDate"
					/>

					<!-- Test Email Card -->
					<div class="card p-6">
						<div class="flex flex-wrap items-center justify-between gap-4">
							<div class="min-w-0">
								<h3 class="text-lg font-semibold text-text-primary">
									{{ t('dashboard.campaigns.detail.edit.test.title') }}
								</h3>
								<p class="text-sm text-text-secondary mt-1">
									{{ t('dashboard.campaigns.detail.edit.test.description') }}
								</p>
							</div>
							<UiButton
								variant="secondary"
								class="gap-2 shrink-0"
								@click="isTestEmailModalOpen = true"
							>
								<Icon name="lucide:send-horizonal" class="w-4 h-4" />
								{{ t('dashboard.campaigns.detail.edit.test.button') }}
							</UiButton>
						</div>
					</div>

					<!-- IP Warmup Status -->
					<CampaignWarmupCard
						v-if="warmingOverview?.warming"
						:warming="warmingOverview.warming"
						:capacity-plan="shownCapacityPlan"
						:capacity-dismissible="Boolean(capacitySchedule)"
						:send-estimate="sendEstimate"
						:audience-size="exactAudienceSize"
						@dismiss-capacity="dismissCapacitySchedule"
					/>

					<!-- Sending readiness, immediately above the send/schedule buttons: the
					     ramp cap belongs where the decision is made, not in a pre-flight
					     refusal after it. Renders nothing when
					     capacity is unmeasured or uncapped-and-unremarkable. -->
					<CampaignsSendReadinessNote
						:readiness="sendingReadiness"
						:audience-size="exactAudienceSize"
					/>

					<CampaignEditActions
						:is-draft="isDraft"
						:is-scheduled="isScheduled"
						:is-saving="isSaving"
						:can-schedule="Boolean(scheduledDate && scheduledTime)"
						@back="handleBack"
						@save="handleSave"
						@schedule="handleSchedule"
						@send-now="showSendConfirm = true"
					/>
				</div>
			</div>
		</UiQueryBoundary>

		<!-- Send-now confirmation -->
		<UiConfirmationDialog
			v-model:open="showSendConfirm"
			variant="warning"
			:title="t('dashboard.campaigns.detail.edit.sendConfirm.title')"
			:description="
				t('dashboard.campaigns.detail.edit.sendConfirm.description', {
					count: audienceCountLabel,
				})
			"
			:confirm-text="t('dashboard.campaigns.detail.edit.actions.sendNow')"
			:is-loading="isSaving"
			@confirm="handleConfirmSend"
		/>

		<!-- Test Email Modal -->
		<CampaignsTestEmailModal
			v-model:open="isTestEmailModalOpen"
			:campaign-id="campaignId"
			:subject="campaignSubject"
			:from-name="fromName"
			:from-email="fromEmail"
			:languages="templateLanguages"
			:default-language="selectedTemplate?.defaultLanguage"
		/>

		<!-- Unsaved Changes Dialog — leaving the page (Back / any navigation) -->
		<UiUnsavedChangesDialog
			:show="showUnsavedChangesDialog"
			:saving="isSavingBeforeLeave"
			@close="cancelNavigation"
			@discard="confirmDiscard"
			@save="confirmSave"
		/>

		<!-- Unsaved Changes Dialog — opening the linked email (new tab; same window on desktop) -->
		<UiUnsavedChangesDialog
			:show="showEditEmailPrompt"
			@close="showEditEmailPrompt = false"
			@discard="discardAndOpenEmail"
			@save="saveAndOpenEmail"
		/>

		<!-- "Cancel send" from the scheduled-campaign reminder: asks first -->
		<CampaignsCampaignCancelIntentDialog
			:is-loaded="!!campaignData"
			:is-scheduled="isScheduled"
			:name="campaignData?.name ?? ''"
			:scheduled-at-display="scheduledAtDisplay"
			:is-loading="isSaving"
			@confirm="handleCancel"
		/>
	</div>
</template>
