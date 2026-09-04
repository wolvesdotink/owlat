<script setup lang="ts">
import { api } from '@owlat/api';
import { UnsavedChangesDialog } from '@owlat/email-builder';
import { isValidEmail } from '@owlat/shared';

const { t, locale } = useI18n();

useHead({ title: () => t('dashboard.campaigns.detail.edit.pageTitle') });

const numberFormat = computed(() => new Intl.NumberFormat(locale.value));
const formatNumber = (value: number) => numberFormat.value.format(value);

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Get campaign ID from route
const campaignId = useRouteId<'campaigns'>();

// Initialize composables
const abTest = useCampaignABTest();

const {
	// Data
	campaignData,
	campaignLoading,
	campaignError,
	topics,
	segments,
	emailTemplates,
	audienceCount,
	audience,

	// Form state
	campaignName,
	fromName,
	fromEmail,
	replyTo,
	audienceType,
	selectedTopicId,
	selectedSegmentId,
	selectedTemplateId,
	campaignSubject,
	archiveEnabled,
	scheduledDate,
	scheduledTime,
	scheduledStartAt,
	useRecipientTimezone,

	// Computed
	selectedTemplate,
	isScheduled,
	isDraft,
	canEdit,
	audienceDisplayText,
	templateLanguages,

	// Errors & loading
	errors,
	isSaving,
	saveError,

	// Unsaved-changes guard
	showUnsavedChangesDialog,
	hasUnsavedChanges,
	confirmDiscard,
	confirmSave,
	cancelNavigation,

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
} = useCampaignForm(campaignId, abTest);

/** The scheduled send moment, formatted against the active locale. */
const scheduledAtDisplay = computed(() => {
	const at = campaignData.value?.scheduledAt;
	return at ? new Date(at).toLocaleString(locale.value) : '';
});

// Guard the "Edit Email" link. It opens the linked email editor in a NEW tab,
// so the SPA route guard never fires — intercept the click and, when the
// campaign form has unsaved edits, prompt to save them first (so the campaign
// and its linked email stay consistent) before opening the editor.
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
const openPendingEmail = () => {
	if (pendingEmailUrl.value) window.open(pendingEmailUrl.value, '_blank', 'noopener');
	closeEditEmailPrompt();
};
const discardAndOpenEmail = () => {
	openPendingEmail();
};
const saveAndOpenEmail = async () => {
	// Open the new tab synchronously inside this click gesture: deferring the
	// window.open() until after the awaited save takes it out of the user-gesture
	// context and most popup blockers swallow it (a regression from the original
	// synchronous target="_blank" link). Clear its opener to match noopener, then
	// navigate it once the save resolves. On failure, discard the blank tab and
	// keep the prompt up (with inline errors) so nothing is lost — handleSave
	// clears the dirty flag only on success.
	const url = pendingEmailUrl.value;
	const tab = url ? window.open('', '_blank') : null;
	if (tab) tab.opener = null;
	if (await handleSave()) {
		if (tab && url) tab.location.href = url;
		closeEditEmailPrompt();
	} else {
		tab?.close();
	}
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

// IP Warmup state
const { data: warmingOverview } = useOrganizationQuery(
	api.analytics.reputationQueries.getSendingOverview
);

// Warming-aware "this campaign will take ~N days" estimate. The projection
// algorithm lives once on the backend (getCampaignSendEstimate); we just feed
// it the eligible recipient count and reshape estimatedDays → days for the
// template. Skips until the audience count is known (factory returns undefined).
const { data: sendEstimateRaw } = useOrganizationQuery(
	api.analytics.reputationQueries.getCampaignSendEstimate,
	() => {
		const count = audienceCount.value?.eligible;
		if (count === undefined) return undefined;
		return { recipientCount: count };
	}
);

const sendEstimate = computed(() => {
	if (!sendEstimateRaw.value) return null;
	return {
		days: sendEstimateRaw.value.estimatedDays,
		isFullyWarmed: sendEstimateRaw.value.isFullyWarmed,
		message: sendEstimateRaw.value.message,
	};
});

// The BINDING capacity plan, previewed BEFORE the operator presses send.
//
// Same assessment pre-flight makes, so the operator sees "Sending over N days"
// as a first-class choice rather than discovering it as a refusal (deliverability
// plan D14 — a multi-day send is a normal, visible state for a warming
// deployment, never a surprise). Skips until there is an audience and a valid
// From address; `fromEmail` is what decides whether warm-up overflow to a
// verified relay absorbs the tail, so previewing without it would answer a
// different question than the gate.
const { data: capacityPreviewRaw } = useOrganizationQuery(
	api.campaigns.capacityPreflight.getCampaignCapacityPlan,
	() => {
		const selected = audience.value;
		const from = fromEmail.value.trim();
		if (!selected || !isValidEmail(from)) return undefined;
		// Anchor on the chosen start when there is one: a campaign scheduled for
		// next week is judged against the capacity it will have then.
		const startsAt = scheduledStartAt.value;
		return { audience: selected, fromEmail: from, ...(startsAt !== null ? { startsAt } : {}) };
	}
);

// TODAY'S HEADROOM, beside the send buttons. The capacity plan above answers
// "how long will this take"; this answers the question the operator asks first —
// how much can go out right now, and when does that grow. Same paced projection
// as the gate, so the two lines cannot disagree. `fromEmail` is passed whenever
// it is valid (it decides whether warm-up overflow absorbs the tail); without
// one the backend answers conservatively rather than skipping, so the line is
// still there while the address is being typed.
const { data: sendingReadiness } = useOrganizationQuery(
	api.campaigns.sendingReadiness.getSendingReadiness,
	() => {
		const from = fromEmail.value.trim();
		return isValidEmail(from) ? { fromEmail: from } : {};
	}
);

/**
 * The schedule to render: the one pre-flight actually refused with, else the
 * preview. The refusal wins — it is the authoritative answer for the send the
 * operator just attempted.
 */
const shownCapacityPlan = computed(() => {
	if (capacitySchedule.value) return capacitySchedule.value;
	const preview = capacityPreviewRaw.value;
	return preview && !preview.fits ? preview.schedule : null;
});
</script>

<template>
	<div class="min-h-full bg-bg-base">
		<!-- Header -->
		<div class="bg-bg-elevated border-b border-border-subtle">
			<div class="max-w-4xl mx-auto px-6 py-4">
				<div class="flex items-center justify-between">
					<div class="flex items-center gap-4">
						<button
							class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
							@click="handleBack"
							:aria-label="t('common.back')"
						>
							<Icon name="lucide:arrow-left" class="w-5 h-5" />
						</button>
						<div>
							<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
								{{
									isScheduled
										? t('dashboard.campaigns.detail.edit.titleScheduled')
										: t('dashboard.campaigns.detail.edit.title')
								}}
							</h1>
							<p class="text-sm text-text-secondary">
								{{ campaignData?.name || t('dashboard.campaigns.detail.edit.loadingName') }}
							</p>
						</div>
					</div>
					<!-- Status Badge -->
					<div v-if="campaignData">
						<span
							v-if="isScheduled"
							class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium bg-brand/10 text-brand"
						>
							<Icon name="lucide:clock" class="w-4 h-4" />
							{{ t('dashboard.campaigns.detail.edit.badges.scheduled') }}
						</span>
						<span
							v-else-if="isDraft"
							class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium bg-text-tertiary/10 text-text-tertiary"
						>
							<Icon name="lucide:pencil" class="w-4 h-4" />
							{{ t('dashboard.campaigns.detail.edit.badges.draft') }}
						</span>
						<span
							v-else-if="campaignData.status === 'pending_review'"
							class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium bg-warning/10 text-warning"
						>
							<Icon name="lucide:shield-alert" class="w-4 h-4" />
							{{ t('dashboard.campaigns.detail.edit.badges.underReview') }}
						</span>
					</div>
				</div>
			</div>
		</div>

		<UiQueryBoundary
			:loading="campaignLoading"
			:error="campaignError"
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

			<!-- Cannot Edit State -->
			<div
				v-else-if="!canEdit && campaignData.status !== 'pending_review'"
				class="max-w-4xl mx-auto px-6 py-16 text-center"
			>
				<UiIconBox
					icon="lucide:alert-circle"
					size="xl"
					variant="surface"
					rounded="full"
					class="mb-4 mx-auto"
				/>
				<p class="text-text-primary font-medium">
					{{ t('dashboard.campaigns.detail.edit.cannotEditTitle') }}
				</p>
				<p class="text-sm text-text-secondary mt-1">
					{{
						t('dashboard.campaigns.detail.edit.cannotEditDescription', {
							status: campaignData.status,
						})
					}}
				</p>
				<UiButton variant="secondary" class="mt-6" @click="handleBack">
					{{ t('dashboard.campaigns.detail.edit.backToCampaigns') }}
				</UiButton>
			</div>

			<!-- Pending Review State -->
			<div v-else-if="campaignData.status === 'pending_review'" class="max-w-4xl mx-auto px-6 py-8">
				<div
					class="p-4 bg-warning/10 border border-warning/20 rounded-lg flex items-start gap-3 mb-6"
				>
					<Icon name="lucide:shield-alert" class="w-5 h-5 text-warning shrink-0 mt-0.5" />
					<div>
						<p class="text-sm font-medium text-text-primary">
							{{ t('dashboard.campaigns.detail.edit.underReview.title') }}
						</p>
						<p class="text-sm text-text-secondary mt-1">
							{{ t('dashboard.campaigns.detail.edit.underReview.description') }}
						</p>
					</div>
				</div>
				<div
					v-if="campaignData.contentBlockReason"
					class="p-4 bg-error/10 border border-error/20 rounded-lg flex items-start gap-3 mb-6"
				>
					<Icon name="lucide:alert-triangle" class="w-5 h-5 text-error shrink-0 mt-0.5" />
					<div>
						<p class="text-sm font-medium text-text-primary">
							{{ t('dashboard.campaigns.detail.edit.underReview.issuesTitle') }}
						</p>
						<p class="text-sm text-text-secondary mt-1">
							{{ campaignData.contentBlockReason }}
						</p>
					</div>
				</div>
				<UiButton variant="secondary" @click="handleBack">
					{{ t('dashboard.campaigns.detail.edit.backToCampaigns') }}
				</UiButton>
			</div>

			<!-- Edit Form -->
			<div v-else class="max-w-4xl mx-auto px-6 py-8">
				<div class="space-y-6">
					<!-- Content Block Reason Alert (shown when campaign was blocked and reverted to draft) -->
					<div
						v-if="campaignData.contentBlockReason"
						class="p-4 bg-error/10 border border-error/20 rounded-lg flex items-start gap-3"
					>
						<Icon name="lucide:shield-alert" class="w-5 h-5 text-error shrink-0 mt-0.5" />
						<div>
							<p class="text-sm font-medium text-text-primary">
								{{ t('dashboard.campaigns.detail.edit.contentBlocked.title') }}
							</p>
							<p class="text-sm text-text-secondary mt-1">
								{{ t('dashboard.campaigns.detail.edit.contentBlocked.description') }}
							</p>
							<p class="text-xs text-text-tertiary mt-1">
								{{ campaignData.contentBlockReason }}
							</p>
						</div>
					</div>
					<!-- Error Alert -->
					<div
						v-if="saveError"
						class="p-4 bg-error/10 border border-error/20 rounded-lg flex items-start gap-3"
					>
						<Icon name="lucide:alert-circle" class="w-5 h-5 text-error shrink-0 mt-0.5" />
						<div>
							<p class="text-sm font-medium text-error">{{ t('common.error') }}</p>
							<p class="text-sm text-error/80">{{ saveError }}</p>
						</div>
					</div>

					<!-- Scheduled Campaign Notice -->
					<div
						v-if="isScheduled && campaignData.scheduledAt"
						class="p-4 bg-brand/10 border border-brand/20 rounded-lg"
					>
						<div class="flex items-start gap-3">
							<Icon name="lucide:clock" class="w-5 h-5 text-brand shrink-0 mt-0.5" />
							<div class="flex-1">
								<p class="text-sm font-medium text-brand">
									{{ t('dashboard.campaigns.detail.edit.scheduledNotice.title') }}
								</p>
								<I18nT
									keypath="dashboard.campaigns.detail.edit.scheduledNotice.description"
									tag="p"
									class="text-sm text-brand/80 mt-1"
									scope="global"
								>
									<template #date>
										<span class="font-medium">{{ scheduledAtDisplay }}</span>
									</template>
								</I18nT>
								<div class="flex gap-2 mt-3">
									<button
										class="text-sm text-brand hover:text-brand/80 font-medium"
										:disabled="isSaving"
										@click="handleUnschedule"
									>
										{{ t('dashboard.campaigns.detail.edit.scheduledNotice.unschedule') }}
									</button>
									<span class="text-brand/40">|</span>
									<button
										class="text-sm text-error hover:text-error/80 font-medium"
										:disabled="isSaving"
										@click="handleCancel"
									>
										{{ t('dashboard.campaigns.detail.edit.scheduledNotice.cancelCampaign') }}
									</button>
								</div>
							</div>
						</div>
					</div>

					<!-- Campaign Details Card -->
					<div class="card p-6">
						<h2 class="text-lg font-semibold text-text-primary mb-6">
							{{ t('dashboard.campaigns.detail.edit.details.title') }}
						</h2>

						<div class="space-y-6">
							<!-- Campaign Name -->
							<div>
								<label for="campaignName" class="label flex items-center gap-2">
									<Icon name="lucide:file-text" class="w-4 h-4 text-text-tertiary" />
									{{ t('dashboard.campaigns.detail.edit.details.campaignName') }}
									<span class="text-error">*</span>
								</label>
								<input
									id="campaignName"
									v-model="campaignName"
									type="text"
									:placeholder="
										t('dashboard.campaigns.detail.edit.details.campaignNamePlaceholder')
									"
									:class="['input mt-1.5', errors.campaignName ? 'input-error' : '']"
									:disabled="isScheduled"
								/>
								<p v-if="errors.campaignName" class="mt-1.5 text-sm text-error">
									{{ errors.campaignName }}
								</p>
							</div>

							<div class="grid grid-cols-1 md:grid-cols-2 gap-6">
								<!-- From Name -->
								<div>
									<label for="fromName" class="label flex items-center gap-2">
										<Icon name="lucide:user" class="w-4 h-4 text-text-tertiary" />
										{{ t('dashboard.campaigns.detail.edit.details.fromName') }}
									</label>
									<input
										id="fromName"
										v-model="fromName"
										type="text"
										:placeholder="t('dashboard.campaigns.detail.edit.details.fromNamePlaceholder')"
										class="input mt-1.5"
										:disabled="isScheduled"
									/>
								</div>

								<!-- From Email -->
								<div>
									<label for="fromEmail" class="label flex items-center gap-2">
										<Icon name="lucide:mail" class="w-4 h-4 text-text-tertiary" />
										{{ t('dashboard.campaigns.detail.edit.details.fromEmail') }}
										<span class="text-error">*</span>
									</label>
									<input
										id="fromEmail"
										v-model="fromEmail"
										type="email"
										:placeholder="t('dashboard.campaigns.detail.edit.details.fromEmailPlaceholder')"
										:class="['input mt-1.5', errors.fromEmail ? 'input-error' : '']"
										:disabled="isScheduled"
									/>
									<p v-if="errors.fromEmail" class="mt-1.5 text-sm text-error">
										{{ errors.fromEmail }}
									</p>
								</div>
							</div>

							<!-- Reply-to -->
							<div>
								<label for="replyTo" class="label flex items-center gap-2">
									<Icon name="lucide:reply" class="w-4 h-4 text-text-tertiary" />
									{{ t('dashboard.campaigns.detail.edit.details.replyTo') }}
									<span class="text-text-tertiary">{{
										t('dashboard.campaigns.detail.edit.details.optionalSuffix')
									}}</span>
								</label>
								<input
									id="replyTo"
									v-model="replyTo"
									type="email"
									:placeholder="t('dashboard.campaigns.detail.edit.details.replyToPlaceholder')"
									class="input mt-1.5"
									:disabled="isScheduled"
								/>
							</div>
						</div>
					</div>

					<!-- Audience Card -->
					<div class="card p-6">
						<h2 class="text-lg font-semibold text-text-primary mb-6">
							{{ t('dashboard.campaigns.detail.edit.audience.title') }}
						</h2>

						<div class="space-y-4">
							<!-- Topic -->
							<label
								:class="[
									'flex items-start gap-4 p-4 border rounded-lg transition-colors',
									isScheduled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
									audienceType === 'topic'
										? 'border-brand bg-brand/5'
										: 'border-border-subtle hover:border-border-default',
								]"
							>
								<input
									v-model="audienceType"
									type="radio"
									name="audienceType"
									value="topic"
									class="mt-1 w-4 h-4 text-brand focus:ring-brand border-border-subtle bg-bg-surface"
									:disabled="isScheduled"
								/>
								<div class="flex-1">
									<div class="flex items-center gap-2">
										<Icon name="lucide:list-checks" class="w-5 h-5 text-brand" />
										<span class="font-medium text-text-primary">{{
											t('dashboard.campaigns.detail.edit.audience.topicTitle')
										}}</span>
									</div>
									<p class="text-sm text-text-secondary mt-1">
										{{ t('dashboard.campaigns.detail.edit.audience.topicDescription') }}
									</p>

									<div v-if="audienceType === 'topic'" class="mt-4">
										<select
											v-model="selectedTopicId"
											:class="['input w-full', errors.audience ? 'input-error' : '']"
											:disabled="isScheduled"
											@click.stop
										>
											<option :value="null" disabled>
												{{ t('dashboard.campaigns.detail.edit.audience.selectTopic') }}
											</option>
											<option v-for="list in topics" :key="list._id" :value="list._id">
												{{
													t('dashboard.campaigns.detail.edit.audience.topicOption', {
														name: list.name,
														count: list.contactCount,
													})
												}}
											</option>
										</select>
										<p v-if="errors.audience" class="mt-1.5 text-sm text-error">
											{{ errors.audience }}
										</p>
									</div>
								</div>
							</label>

							<!-- Segment -->
							<label
								:class="[
									'flex items-start gap-4 p-4 border rounded-lg transition-colors',
									isScheduled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
									audienceType === 'segment'
										? 'border-brand bg-brand/5'
										: 'border-border-subtle hover:border-border-default',
								]"
							>
								<input
									v-model="audienceType"
									type="radio"
									name="audienceType"
									value="segment"
									class="mt-1 w-4 h-4 text-brand focus:ring-brand border-border-subtle bg-bg-surface"
									:disabled="isScheduled"
								/>
								<div class="flex-1">
									<div class="flex items-center gap-2">
										<Icon name="lucide:filter" class="w-5 h-5 text-warning" />
										<span class="font-medium text-text-primary">{{
											t('dashboard.campaigns.detail.edit.audience.segmentTitle')
										}}</span>
									</div>
									<p class="text-sm text-text-secondary mt-1">
										{{ t('dashboard.campaigns.detail.edit.audience.segmentDescription') }}
									</p>

									<div v-if="audienceType === 'segment'" class="mt-4">
										<select
											v-model="selectedSegmentId"
											:class="['input w-full', errors.audience ? 'input-error' : '']"
											:disabled="isScheduled"
											@click.stop
										>
											<option :value="null" disabled>
												{{ t('dashboard.campaigns.detail.edit.audience.selectSegment') }}
											</option>
											<option v-for="segment in segments" :key="segment._id" :value="segment._id">
												{{ segment.name }}
											</option>
										</select>
										<p v-if="errors.audience" class="mt-1.5 text-sm text-error">
											{{ errors.audience }}
										</p>
									</div>
								</div>
							</label>

							<!-- Audience Count -->
							<div class="p-4 bg-bg-surface shadow-surface-1 rounded-lg">
								<div class="flex items-center justify-between">
									<div class="flex items-center gap-2">
										<Icon name="lucide:users" class="w-5 h-5 text-text-tertiary" />
										<span class="text-text-secondary">{{ audienceDisplayText }}</span>
									</div>
									<span class="text-xl font-semibold text-brand">{{
										audienceCount?.eligible ?? 0
									}}</span>
								</div>
								<p v-if="audienceType === 'topic'" class="mt-1 text-sm text-text-tertiary">
									{{ t('dashboard.campaigns.detail.edit.audience.eligibleForTopic') }}
								</p>
								<p v-else class="mt-1 text-sm text-text-tertiary">
									{{ t('dashboard.campaigns.detail.edit.audience.eligible') }}
								</p>

								<!-- Warning if there are non-opted-in contacts (only for topic) -->
								<div
									v-if="
										audienceType === 'topic' &&
										audienceCount &&
										audienceCount.total > audienceCount.eligible
									"
									class="mt-3 p-3 bg-warning/10 border border-warning/20 rounded-lg"
								>
									<div class="flex items-start gap-2">
										<Icon
											name="lucide:alert-triangle"
											class="w-4 h-4 text-warning shrink-0 mt-0.5"
										/>
										<div class="text-sm">
											<p class="text-warning font-medium">
												{{ t('dashboard.campaigns.detail.edit.audience.ineligibleTitle') }}
											</p>
											<p class="text-warning/80 mt-0.5">
												{{
													t('dashboard.campaigns.detail.edit.audience.ineligibleDescription', {
														excluded: audienceCount.total - audienceCount.eligible,
														total: audienceCount.total,
													})
												}}
											</p>
										</div>
									</div>
								</div>
							</div>
						</div>
					</div>

					<!-- Email Content Card -->
					<div class="card p-6">
						<h2 class="text-lg font-semibold text-text-primary mb-6">
							{{ t('dashboard.campaigns.detail.edit.content.title') }}
						</h2>

						<div class="space-y-6">
							<!-- Selected Template -->
							<div>
								<label class="label">
									{{ t('dashboard.campaigns.detail.edit.content.template') }}
									<span class="text-error">*</span>
								</label>
								<div
									v-if="selectedTemplate"
									class="mt-2 p-4 bg-bg-surface shadow-surface-1 rounded-lg"
								>
									<div class="flex items-center justify-between">
										<div class="flex items-center gap-3">
											<div
												class="w-10 h-10 rounded-lg bg-brand/20 flex items-center justify-center text-brand"
											>
												<Icon name="lucide:mail" class="w-5 h-5" />
											</div>
											<div class="min-w-0">
												<p class="font-medium text-text-primary truncate">
													{{ selectedTemplate.name }}
												</p>
												<p class="text-sm text-text-secondary truncate">
													{{
														selectedTemplate.subject ||
														t('dashboard.campaigns.detail.edit.content.noSubject')
													}}
												</p>
											</div>
										</div>
										<NuxtLink
											:to="`/dashboard/send/emails/${selectedTemplate._id}/edit`"
											class="text-brand hover:text-brand-hover flex items-center gap-1 text-sm"
											target="_blank"
											@click="
												onEditEmailClick(
													$event,
													`/dashboard/send/emails/${selectedTemplate._id}/edit`
												)
											"
										>
											<Icon name="lucide:eye" class="w-4 h-4" />
											{{ t('dashboard.campaigns.detail.edit.content.editEmail') }}
										</NuxtLink>
									</div>
								</div>
								<div
									v-else
									class="mt-2 p-4 bg-bg-surface shadow-surface-1 rounded-lg text-text-tertiary"
								>
									{{ t('dashboard.campaigns.detail.edit.content.noTemplate') }}
								</div>
								<p v-if="errors.content" class="mt-1.5 text-sm text-error">
									{{ errors.content }}
								</p>

								<p class="mt-3 text-sm text-text-tertiary">
									{{ t('dashboard.campaigns.detail.edit.content.linkedEmailNote') }}
								</p>
							</div>

							<!-- Subject Line -->
							<div>
								<label for="subject" class="label flex items-center gap-2">
									<Icon name="lucide:mail" class="w-4 h-4 text-text-tertiary" />
									{{ t('dashboard.campaigns.detail.edit.content.subject') }}
									<span class="text-error">*</span>
								</label>
								<input
									id="subject"
									v-model="campaignSubject"
									type="text"
									:placeholder="t('dashboard.campaigns.detail.edit.content.subjectPlaceholder')"
									:class="['input mt-1.5', errors.subject ? 'input-error' : '']"
									:disabled="isScheduled"
								/>
								<p v-if="errors.subject" class="mt-1.5 text-sm text-error">
									{{ errors.subject }}
								</p>
							</div>
						</div>
					</div>

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
						<div class="flex items-center justify-between">
							<div>
								<h3 class="text-lg font-semibold text-text-primary">
									{{ t('dashboard.campaigns.detail.edit.archive.title') }}
								</h3>
								<p class="text-sm text-text-secondary mt-1">
									{{ t('dashboard.campaigns.detail.edit.archive.description') }}
								</p>
							</div>
							<UiSwitch
								v-model="archiveEnabled"
								:disabled="isScheduled"
								:label="t('dashboard.campaigns.detail.edit.archive.switchLabel')"
							/>
						</div>
					</div>

					<!-- Schedule Card -->
					<div class="card p-6">
						<h2 class="text-lg font-semibold text-text-primary mb-6">
							{{
								isScheduled
									? t('dashboard.campaigns.detail.edit.schedule.retitle')
									: t('dashboard.campaigns.detail.edit.schedule.title')
							}}
						</h2>

						<div class="grid grid-cols-2 gap-4">
							<div>
								<label for="scheduleDate" class="label flex items-center gap-2">
									<Icon name="lucide:calendar" class="w-4 h-4 text-text-tertiary" />
									{{ t('dashboard.campaigns.detail.edit.schedule.date') }}
								</label>
								<input
									id="scheduleDate"
									v-model="scheduledDate"
									type="date"
									:min="getMinScheduleDate()"
									class="input mt-1.5"
								/>
							</div>
							<div>
								<label for="scheduleTime" class="label flex items-center gap-2">
									<Icon name="lucide:clock" class="w-4 h-4 text-text-tertiary" />
									{{ t('dashboard.campaigns.detail.edit.schedule.time') }}
								</label>
								<input id="scheduleTime" v-model="scheduledTime" type="time" class="input mt-1.5" />
							</div>
						</div>

						<!-- Timezone Scheduling Option (also honored on reschedule — toggles local-time delivery) -->
						<div class="mt-4">
							<label
								class="flex items-start gap-3 p-3 bg-bg-elevated shadow-surface-1 rounded-lg cursor-pointer hover:bg-bg-surface-hover transition-colors"
							>
								<input
									v-model="useRecipientTimezone"
									type="checkbox"
									class="mt-0.5 w-4 h-4 text-brand focus:ring-brand border-border-subtle bg-bg-surface rounded"
								/>
								<div class="flex-1">
									<div class="flex items-center gap-2">
										<Icon name="lucide:globe" class="w-4 h-4 text-brand" />
										<span class="font-medium text-text-primary text-sm">
											{{ t('dashboard.campaigns.detail.edit.schedule.recipientTimezone') }}
										</span>
									</div>
									<p class="text-xs text-text-secondary mt-1">
										{{
											t('dashboard.campaigns.detail.edit.schedule.recipientTimezoneHint', {
												time:
													scheduledTime ||
													t('dashboard.campaigns.detail.edit.schedule.theScheduledTime'),
											})
										}}
									</p>
								</div>
							</label>
						</div>

						<div
							v-if="scheduledDate && scheduledTime"
							class="mt-4 p-3 bg-bg-surface shadow-surface-1 rounded-lg"
						>
							<template v-if="useRecipientTimezone">
								<p class="text-sm text-text-secondary">
									{{ t('dashboard.campaigns.detail.edit.schedule.willBeSentAt') }}
								</p>
								<p class="font-medium text-text-primary mt-1">
									{{
										t('dashboard.campaigns.detail.edit.schedule.inRecipientTimezone', {
											time: scheduledTime,
										})
									}}
								</p>
								<p class="text-xs text-text-tertiary mt-2">
									{{
										t('dashboard.campaigns.detail.edit.schedule.timezoneExamples', {
											time: scheduledTime,
										})
									}}
								</p>
							</template>
							<template v-else>
								<p class="text-sm text-text-secondary">
									{{ t('dashboard.campaigns.detail.edit.schedule.willBeSent') }}
								</p>
								<p class="font-medium text-text-primary mt-1">
									{{ formatDate(scheduledDate, scheduledTime) }}
								</p>
							</template>
						</div>
					</div>

					<!-- Test Email Card -->
					<div class="card p-6">
						<div class="flex items-center justify-between">
							<div>
								<h3 class="text-lg font-semibold text-text-primary">
									{{ t('dashboard.campaigns.detail.edit.test.title') }}
								</h3>
								<p class="text-sm text-text-secondary mt-1">
									{{ t('dashboard.campaigns.detail.edit.test.description') }}
								</p>
							</div>
							<UiButton variant="secondary" class="gap-2" @click="isTestEmailModalOpen = true">
								<Icon name="lucide:send-horizonal" class="w-4 h-4" />
								{{ t('dashboard.campaigns.detail.edit.test.button') }}
							</UiButton>
						</div>
					</div>

					<!-- IP Warmup Status -->
					<div v-if="warmingOverview?.warming" class="card p-6">
						<div class="flex items-center gap-3 mb-4">
							<UiIconBox icon="lucide:flame" size="lg" variant="brand" rounded="xl" />
							<div>
								<h2 class="text-lg font-semibold text-text-primary">
									{{ t('dashboard.campaigns.detail.edit.warmup.title') }}
								</h2>
								<p class="text-sm text-text-secondary">
									{{ t('dashboard.campaigns.detail.edit.warmup.subtitle') }}
								</p>
							</div>
						</div>

						<!-- Graduated State -->
						<div
							v-if="warmingOverview.warming.phase === 'graduated'"
							class="flex items-center gap-3 p-4 bg-success/10 border border-success/20 rounded-lg"
						>
							<Icon name="lucide:check-circle" class="w-5 h-5 text-success shrink-0" />
							<div>
								<p class="text-sm font-medium text-success">
									{{ t('dashboard.campaigns.detail.edit.warmup.graduatedTitle') }}
								</p>
								<p class="text-sm text-text-secondary">
									{{ t('dashboard.campaigns.detail.edit.warmup.graduatedDescription') }}
								</p>
							</div>
						</div>

						<!-- Warming State -->
						<div v-else class="space-y-4">
							<!-- Progress -->
							<div>
								<div class="flex items-center justify-between mb-2">
									<p class="text-sm text-text-secondary">
										{{ t('dashboard.campaigns.detail.edit.warmup.progress') }}
									</p>
									<p class="text-sm font-medium text-text-primary">
										{{
											t('dashboard.campaigns.detail.edit.warmup.dayOf', {
												day: warmingOverview.warming.ips?.[0]?.currentDay ?? 1,
											})
										}}
									</p>
								</div>
								<div class="w-full h-2.5 bg-bg-surface rounded-full overflow-hidden">
									<div
										class="h-full bg-brand rounded-full transition-all duration-(--motion-slow)"
										:style="{
											width: `${Math.min(100, Math.round(((warmingOverview.warming.ips?.[0]?.currentDay ?? 1) / 30) * 100))}%`,
										}"
									/>
								</div>
							</div>

							<!-- Today's Capacity -->
							<div class="flex items-center justify-between p-3 bg-bg-surface rounded-lg">
								<p class="text-sm text-text-secondary">
									{{ t('dashboard.campaigns.detail.edit.warmup.remainingCapacity') }}
								</p>
								<p class="text-sm font-medium text-text-primary">
									{{
										t('dashboard.campaigns.detail.edit.warmup.remainingOfCap', {
											remaining: formatNumber(
												Math.max(
													0,
													warmingOverview.warming.totalDailyCap -
														warmingOverview.warming.totalSentToday
												)
											),
											cap: formatNumber(warmingOverview.warming.totalDailyCap),
										})
									}}
								</p>
							</div>

							<!-- The multi-day schedule: previewed BEFORE the send, and re-rendered
							     from the refusal itself when pre-flight hands one back. Capacity is a
							     schedule, not a failure (deliverability plan D14). -->
							<CampaignsCapacitySchedulePanel
								v-if="shownCapacityPlan"
								:plan="shownCapacityPlan"
								:dismissible="Boolean(capacitySchedule)"
								@dismiss="dismissCapacitySchedule"
							/>

							<!-- Send Estimate -->
							<div
								v-if="!shownCapacityPlan && sendEstimate && audienceCount && sendEstimate.days > 1"
								class="flex items-start gap-3 p-3 bg-warning/10 border border-warning/20 rounded-lg"
							>
								<Icon name="lucide:clock" class="w-5 h-5 text-warning shrink-0 mt-0.5" />
								<div>
									<p class="text-sm font-medium text-text-primary">
										{{
											t(
												'dashboard.campaigns.detail.edit.warmup.estimatedDays',
												{ days: sendEstimate.days },
												sendEstimate.days
											)
										}}
									</p>
									<p class="text-sm text-text-secondary mt-0.5">
										{{
											t('dashboard.campaigns.detail.edit.warmup.estimateDetail', {
												count: formatNumber(audienceCount.eligible ?? 0),
												message: sendEstimate.message,
											})
										}}
									</p>
								</div>
							</div>
						</div>
					</div>

					<!-- Sending readiness, immediately above the send/schedule buttons: the
					     ramp cap belongs where the decision is made, not in a pre-flight
					     refusal after it (deliverability plan D14). Renders nothing when
					     capacity is unmeasured or uncapped-and-unremarkable. -->
					<CampaignsSendReadinessNote
						:readiness="sendingReadiness"
						:audience-size="audienceCount?.eligible ?? null"
					/>

					<!-- Actions -->
					<div class="flex items-center justify-between pt-4">
						<UiButton variant="secondary" type="button" @click="handleBack">
							{{ t('common.cancel') }}
						</UiButton>
						<div class="flex items-center gap-3">
							<!-- Save button for draft campaigns -->
							<UiButton
								variant="secondary"
								v-if="isDraft"
								class="gap-2"
								:disabled="isSaving"
								@click="handleSave"
							>
								<Icon
									v-if="isSaving"
									name="lucide:loader-2"
									class="w-4 h-4 animate-spin motion-reduce:animate-none"
								/>
								{{ t('dashboard.campaigns.detail.edit.actions.saveDraft') }}
							</UiButton>

							<!-- Schedule button -->
							<UiButton
								variant="secondary"
								class="gap-2"
								:disabled="isSaving || !scheduledDate || !scheduledTime"
								@click="handleSchedule"
							>
								<Icon
									v-if="isSaving"
									name="lucide:loader-2"
									class="w-4 h-4 animate-spin motion-reduce:animate-none"
								/>
								<Icon v-else name="lucide:clock" class="w-4 h-4" />
								{{
									isScheduled
										? t('dashboard.campaigns.detail.edit.actions.reschedule')
										: t('dashboard.campaigns.detail.edit.actions.schedule')
								}}
							</UiButton>

							<!-- Send Now button -->
							<UiButton class="gap-2" :disabled="isSaving" @click="showSendConfirm = true">
								<Icon
									v-if="isSaving"
									name="lucide:loader-2"
									class="w-4 h-4 animate-spin motion-reduce:animate-none"
								/>
								<Icon v-else name="lucide:send" class="w-4 h-4" />
								{{ t('dashboard.campaigns.detail.edit.actions.sendNow') }}
							</UiButton>
						</div>
					</div>
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
					count: formatNumber(audienceCount?.eligible ?? 0),
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
		<UnsavedChangesDialog
			:show="showUnsavedChangesDialog"
			@close="cancelNavigation"
			@discard="confirmDiscard"
			@save="confirmSave"
		/>

		<!-- Unsaved Changes Dialog — opening the linked email in a new tab -->
		<UnsavedChangesDialog
			:show="showEditEmailPrompt"
			@close="showEditEmailPrompt = false"
			@discard="discardAndOpenEmail"
			@save="saveAndOpenEmail"
		/>
	</div>
</template>
