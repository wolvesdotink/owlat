<script setup lang="ts">
import { api } from '@owlat/api';
import { UnsavedChangesDialog } from '@owlat/email-builder';
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Edit Campaign — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const route = useRoute();

// Get campaign ID from route
const campaignId = computed(() => route.params['id'] as Id<'campaigns'>);

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

	// Helpers
	formatDate,
	getMinScheduleDate,
	getLanguageLabel,
} = useCampaignForm(campaignId, abTest);

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
</script>

<template>
	<div class="min-h-full bg-bg-base">
		<!-- Header -->
		<div class="bg-bg-elevated border-b border-border-subtle">
			<div class="max-w-4xl mx-auto px-6 py-4">
				<div class="flex items-center justify-between">
					<div class="flex items-center gap-4">
						<button
							class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
							@click="handleBack"
							aria-label="Back"
						>
							<Icon name="lucide:arrow-left" class="w-5 h-5" />
						</button>
						<div>
							<h1 class="text-lg font-semibold text-text-primary">
								{{ isScheduled ? 'Edit Scheduled Campaign' : 'Edit Campaign' }}
							</h1>
							<p class="text-sm text-text-secondary">
								{{ campaignData?.name || 'Loading...' }}
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
							Scheduled
						</span>
						<span
							v-else-if="isDraft"
							class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium bg-text-tertiary/10 text-text-tertiary"
						>
							<Icon name="lucide:pencil" class="w-4 h-4" />
							Draft
						</span>
						<span
							v-else-if="campaignData.status === 'pending_review'"
							class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium bg-warning/10 text-warning"
						>
							<Icon name="lucide:shield-alert" class="w-4 h-4" />
							Under Review
						</span>
					</div>
				</div>
			</div>
		</div>

		<UiQueryBoundary
			:loading="campaignLoading"
			:error="campaignError"
			error-title="Couldn't load this campaign"
			loading-label="Loading campaign..."
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
				<p class="text-text-primary font-medium">Campaign not found</p>
				<p class="text-sm text-text-secondary mt-1">
					The campaign you're looking for doesn't exist or you don't have access to it.
				</p>
				<button class="btn btn-secondary mt-6" @click="handleBack">Back to Campaigns</button>
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
				<p class="text-text-primary font-medium">Cannot edit this campaign</p>
				<p class="text-sm text-text-secondary mt-1">
					This campaign is {{ campaignData.status }} and cannot be edited.
				</p>
				<button class="btn btn-secondary mt-6" @click="handleBack">Back to Campaigns</button>
			</div>

			<!-- Pending Review State -->
			<div v-else-if="campaignData.status === 'pending_review'" class="max-w-4xl mx-auto px-6 py-8">
				<div
					class="p-4 bg-warning/10 border border-warning/20 rounded-lg flex items-start gap-3 mb-6"
				>
					<Icon name="lucide:shield-alert" class="w-5 h-5 text-warning shrink-0 mt-0.5" />
					<div>
						<p class="text-sm font-medium text-text-primary">Campaign Under Review</p>
						<p class="text-sm text-text-secondary mt-1">
							This campaign has been flagged by our content scanner and is pending review by a
							platform administrator. You will be able to send it once it has been approved.
						</p>
					</div>
				</div>
				<div
					v-if="campaignData.contentBlockReason"
					class="p-4 bg-error/10 border border-error/20 rounded-lg flex items-start gap-3 mb-6"
				>
					<Icon name="lucide:alert-triangle" class="w-5 h-5 text-error shrink-0 mt-0.5" />
					<div>
						<p class="text-sm font-medium text-text-primary">Content Issues Detected</p>
						<p class="text-sm text-text-secondary mt-1">
							{{ campaignData.contentBlockReason }}
						</p>
					</div>
				</div>
				<button class="btn btn-secondary" @click="handleBack">Back to Campaigns</button>
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
							<p class="text-sm font-medium text-text-primary">Content Blocked</p>
							<p class="text-sm text-text-secondary mt-1">
								Your previous send attempt was blocked by our content scanner. Please update your
								content and try again.
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
							<p class="text-sm font-medium text-error">Error</p>
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
								<p class="text-sm font-medium text-brand">Campaign Scheduled</p>
								<p class="text-sm text-brand/80 mt-1">
									This campaign is scheduled to send on
									<span class="font-medium">{{
										new Date(campaignData.scheduledAt).toLocaleString()
									}}</span
									>. You can reschedule it, send it now, or cancel it.
								</p>
								<div class="flex gap-2 mt-3">
									<button
										class="text-sm text-brand hover:text-brand/80 font-medium"
										:disabled="isSaving"
										@click="handleUnschedule"
									>
										Unschedule to Edit
									</button>
									<span class="text-brand/40">|</span>
									<button
										class="text-sm text-error hover:text-error/80 font-medium"
										:disabled="isSaving"
										@click="handleCancel"
									>
										Cancel Campaign
									</button>
								</div>
							</div>
						</div>
					</div>

					<!-- Campaign Details Card -->
					<div class="card p-6">
						<h2 class="text-lg font-semibold text-text-primary mb-6">Campaign Details</h2>

						<div class="space-y-6">
							<!-- Campaign Name -->
							<div>
								<label for="campaignName" class="label flex items-center gap-2">
									<Icon name="lucide:file-text" class="w-4 h-4 text-text-tertiary" />
									Campaign Name <span class="text-error">*</span>
								</label>
								<input
									id="campaignName"
									v-model="campaignName"
									type="text"
									placeholder="e.g., Summer Newsletter 2026"
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
										From Name
									</label>
									<input
										id="fromName"
										v-model="fromName"
										type="text"
										placeholder="e.g., John from Acme Inc"
										class="input mt-1.5"
										:disabled="isScheduled"
									/>
								</div>

								<!-- From Email -->
								<div>
									<label for="fromEmail" class="label flex items-center gap-2">
										<Icon name="lucide:mail" class="w-4 h-4 text-text-tertiary" />
										From Email <span class="text-error">*</span>
									</label>
									<input
										id="fromEmail"
										v-model="fromEmail"
										type="email"
										placeholder="e.g., hello@acme.com"
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
									Reply-to Email <span class="text-text-tertiary">(optional)</span>
								</label>
								<input
									id="replyTo"
									v-model="replyTo"
									type="email"
									placeholder="e.g., support@acme.com"
									class="input mt-1.5"
									:disabled="isScheduled"
								/>
							</div>
						</div>
					</div>

					<!-- Audience Card -->
					<div class="card p-6">
						<h2 class="text-lg font-semibold text-text-primary mb-6">Audience</h2>

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
										<span class="font-medium text-text-primary">Specific Topic</span>
									</div>
									<p class="text-sm text-text-secondary mt-1">
										Send to contacts subscribed to a specific topic.
									</p>

									<div v-if="audienceType === 'topic'" class="mt-4">
										<select
											v-model="selectedTopicId"
											:class="['input w-full', errors.audience ? 'input-error' : '']"
											:disabled="isScheduled"
											@click.stop
										>
											<option :value="null" disabled>Select a topic...</option>
											<option v-for="list in topics" :key="list._id" :value="list._id">
												{{ list.name }} ({{ list.contactCount }} contacts)
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
										<span class="font-medium text-text-primary">Saved Segment</span>
									</div>
									<p class="text-sm text-text-secondary mt-1">
										Target contacts matching specific criteria.
									</p>

									<div v-if="audienceType === 'segment'" class="mt-4">
										<select
											v-model="selectedSegmentId"
											:class="['input w-full', errors.audience ? 'input-error' : '']"
											:disabled="isScheduled"
											@click.stop
										>
											<option :value="null" disabled>Select a segment...</option>
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
							<div class="p-4 bg-bg-surface border border-border-subtle rounded-lg">
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
									eligible recipients for this topic
								</p>
								<p v-else class="mt-1 text-sm text-text-tertiary">eligible recipients</p>

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
												Some subscribers won't receive this campaign
											</p>
											<p class="text-warning/80 mt-0.5">
												{{ audienceCount.total - audienceCount.eligible }} of
												{{ audienceCount.total }} contacts in this topic are not eligible (no email
												address, unsubscribed/suppressed, or double opt-in not completed) and will
												be excluded.
											</p>
										</div>
									</div>
								</div>
							</div>
						</div>
					</div>

					<!-- Email Content Card -->
					<div class="card p-6">
						<h2 class="text-lg font-semibold text-text-primary mb-6">Email Content</h2>

						<div class="space-y-6">
							<!-- Selected Template -->
							<div>
								<label class="label">Email Template <span class="text-error">*</span></label>
								<div
									v-if="selectedTemplate"
									class="mt-2 p-4 bg-bg-surface border border-border-subtle rounded-lg"
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
													{{ selectedTemplate.subject || 'No subject' }}
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
											Edit Email
										</NuxtLink>
									</div>
								</div>
								<div
									v-else
									class="mt-2 p-4 bg-bg-surface border border-border-subtle rounded-lg text-text-tertiary"
								>
									No template selected
								</div>
								<p v-if="errors.content" class="mt-1.5 text-sm text-error">
									{{ errors.content }}
								</p>

								<p class="mt-3 text-sm text-text-tertiary">
									This campaign is linked to one marketing email. Edit the linked email in the
									builder.
								</p>
							</div>

							<!-- Subject Line -->
							<div>
								<label for="subject" class="label flex items-center gap-2">
									<Icon name="lucide:mail" class="w-4 h-4 text-text-tertiary" />
									Email Subject <span class="text-error">*</span>
								</label>
								<input
									id="subject"
									v-model="campaignSubject"
									type="text"
									placeholder="e.g., Your weekly newsletter is here!"
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
								<h3 class="text-lg font-semibold text-text-primary">Public Archive</h3>
								<p class="text-sm text-text-secondary mt-1">
									Add a "View in browser" link at the top of sent emails and create a public archive
									page.
								</p>
							</div>
							<UiSwitch v-model="archiveEnabled" :disabled="isScheduled" label="Public archive" />
						</div>
					</div>

					<!-- Schedule Card -->
					<div class="card p-6">
						<h2 class="text-lg font-semibold text-text-primary mb-6">
							{{ isScheduled ? 'Reschedule Campaign' : 'Schedule Campaign' }}
						</h2>

						<div class="grid grid-cols-2 gap-4">
							<div>
								<label for="scheduleDate" class="label flex items-center gap-2">
									<Icon name="lucide:calendar" class="w-4 h-4 text-text-tertiary" />
									Date
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
									Time
								</label>
								<input id="scheduleTime" v-model="scheduledTime" type="time" class="input mt-1.5" />
							</div>
						</div>

						<!-- Timezone Scheduling Option (also honored on reschedule — toggles local-time delivery) -->
						<div class="mt-4">
							<label
								class="flex items-start gap-3 p-3 bg-bg-elevated border border-border-subtle rounded-lg cursor-pointer hover:border-border-default transition-colors"
							>
								<input
									v-model="useRecipientTimezone"
									type="checkbox"
									class="mt-0.5 w-4 h-4 text-brand focus:ring-brand border-border-subtle bg-bg-surface rounded"
								/>
								<div class="flex-1">
									<div class="flex items-center gap-2">
										<Icon name="lucide:globe" class="w-4 h-4 text-brand" />
										<span class="font-medium text-text-primary text-sm"
											>Send at recipient's local time</span
										>
									</div>
									<p class="text-xs text-text-secondary mt-1">
										Emails will be sent at {{ scheduledTime || 'the scheduled time' }} in each
										contact's timezone. Contacts without a timezone will receive the email at your
										selected time.
									</p>
								</div>
							</label>
						</div>

						<div
							v-if="scheduledDate && scheduledTime"
							class="mt-4 p-3 bg-bg-surface border border-border-subtle rounded-lg"
						>
							<template v-if="useRecipientTimezone">
								<p class="text-sm text-text-secondary">Campaign will be sent at:</p>
								<p class="font-medium text-text-primary mt-1">
									{{ scheduledTime }} in each recipient's timezone
								</p>
								<p class="text-xs text-text-tertiary mt-2">
									For example: {{ scheduledTime }} ET, {{ scheduledTime }} PT,
									{{ scheduledTime }} GMT, etc.
								</p>
							</template>
							<template v-else>
								<p class="text-sm text-text-secondary">Campaign will be sent:</p>
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
								<h3 class="text-lg font-semibold text-text-primary">Send Test Email</h3>
								<p class="text-sm text-text-secondary mt-1">Preview how your email will look.</p>
							</div>
							<button class="btn btn-secondary gap-2" @click="isTestEmailModalOpen = true">
								<Icon name="lucide:send-horizonal" class="w-4 h-4" />
								Send Test
							</button>
						</div>
					</div>

					<!-- IP Warmup Status -->
					<div v-if="warmingOverview?.warming" class="card p-6">
						<div class="flex items-center gap-3 mb-4">
							<UiIconBox icon="lucide:flame" size="lg" variant="brand" rounded="xl" />
							<div>
								<h2 class="text-lg font-semibold text-text-primary">IP Warmup Status</h2>
								<p class="text-sm text-text-secondary">
									Your sending capacity based on IP reputation warming
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
								<p class="text-sm font-medium text-success">Fully Warmed</p>
								<p class="text-sm text-text-secondary">
									Your IPs are fully warmed. Campaigns will send at full speed.
								</p>
							</div>
						</div>

						<!-- Warming State -->
						<div v-else class="space-y-4">
							<!-- Progress -->
							<div>
								<div class="flex items-center justify-between mb-2">
									<p class="text-sm text-text-secondary">Warmup progress</p>
									<p class="text-sm font-medium text-text-primary">
										Day {{ warmingOverview.warming.ips?.[0]?.currentDay ?? 1 }} of ~30
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
								<p class="text-sm text-text-secondary">Today's remaining capacity</p>
								<p class="text-sm font-medium text-text-primary">
									{{
										Math.max(
											0,
											warmingOverview.warming.totalDailyCap - warmingOverview.warming.totalSentToday
										).toLocaleString()
									}}
									of {{ warmingOverview.warming.totalDailyCap.toLocaleString() }} emails
								</p>
							</div>

							<!-- Send Estimate -->
							<div
								v-if="sendEstimate && audienceCount && sendEstimate.days > 1"
								class="flex items-start gap-3 p-3 bg-warning/10 border border-warning/20 rounded-lg"
							>
								<Icon name="lucide:clock" class="w-5 h-5 text-warning shrink-0 mt-0.5" />
								<div>
									<p class="text-sm font-medium text-text-primary">
										Estimated send time: ~{{ sendEstimate.days }} day{{
											sendEstimate.days === 1 ? '' : 's'
										}}
									</p>
									<p class="text-sm text-text-secondary mt-0.5">
										This campaign has
										{{ (audienceCount.eligible ?? 0).toLocaleString() }} recipients.
										{{ sendEstimate.message }}
									</p>
								</div>
							</div>
						</div>
					</div>

					<!-- Actions -->
					<div class="flex items-center justify-between pt-4">
						<button type="button" class="btn btn-secondary" @click="handleBack">Cancel</button>
						<div class="flex items-center gap-3">
							<!-- Save button for draft campaigns -->
							<button
								v-if="isDraft"
								class="btn btn-secondary gap-2"
								:disabled="isSaving"
								@click="handleSave"
							>
								<Icon v-if="isSaving" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
								Save Draft
							</button>

							<!-- Schedule button -->
							<button
								class="btn btn-secondary gap-2"
								:disabled="isSaving || !scheduledDate || !scheduledTime"
								@click="handleSchedule"
							>
								<Icon v-if="isSaving" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
								<Icon v-else name="lucide:clock" class="w-4 h-4" />
								{{ isScheduled ? 'Reschedule' : 'Schedule' }}
							</button>

							<!-- Send Now button -->
							<button
								class="btn btn-primary gap-2"
								:disabled="isSaving"
								@click="showSendConfirm = true"
							>
								<Icon v-if="isSaving" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
								<Icon v-else name="lucide:send" class="w-4 h-4" />
								Send Now
							</button>
						</div>
					</div>
				</div>
			</div>
		</UiQueryBoundary>

		<!-- Send-now confirmation -->
		<UiConfirmationDialog
			v-model:open="showSendConfirm"
			variant="warning"
			title="Send campaign now?"
			:description="`This sends to ${(audienceCount?.eligible ?? 0).toLocaleString()} recipient(s) immediately and can't be undone.`"
			confirm-text="Send Now"
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
