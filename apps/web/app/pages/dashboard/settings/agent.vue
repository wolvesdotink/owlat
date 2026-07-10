<script setup lang="ts">
import { api } from '@owlat/api';

useHead({ title: 'AI Agent Settings — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	// Gate by URL too — the nav hides this link when ai.agent is off; re-enable
	// via the always-on Features settings page.
	requiresFeature: 'ai.agent',
});

// Agent on/off is the `ai.agent` feature flag — not a column on agentConfig.
const { flags } = useFeatureFlag();
const { run: setFeatureFlag } = useBackendOperation(api.organizations.featureFlags.setFeatureFlag, {
	label: 'Toggle agent',
});

// Fetch current operational tuning (threshold, tone, signature, …)
const { data: config, isLoading } = useConvexQuery(api.agentConfigMutations.getConfig, () => ({}));
const { run: updateConfig } = useBackendOperation(api.agentConfigMutations.updateConfig, {
	label: 'Save agent settings',
});

// Knowledge backfill status (live-reactive Convex query — no manual polling)
const { data: backfillJob } = useConvexQuery(
	api.agent.knowledgeBackfill.getStatus,
	() => ({})
);
const { run: cancelBackfill } = useBackendOperation(api.agent.knowledgeBackfill.cancel, {
	label: 'Cancel backfill',
});

const backfillProgressPercent = computed(() => {
	const job = backfillJob.value;
	if (!job || job.totalCount <= 0) return 0;
	const pct = Math.round((job.scannedCount / job.totalCount) * 100);
	return Math.min(100, Math.max(0, pct));
});

const isCancellingBackfill = ref(false);
const handleCancelBackfill = async () => {
	isCancellingBackfill.value = true;
	const result = await cancelBackfill({});
	isCancellingBackfill.value = false;
	if (result === undefined) return;
	showToast('Backfill cancelled');
};

const backfillStatusLabel = computed(() => {
	const job = backfillJob.value;
	if (!job) return '';
	switch (job.status) {
		case 'pending': return 'Queued';
		case 'running': return 'Scanning mail history';
		case 'completed': return 'Complete';
		case 'cancelled': return 'Cancelled';
		case 'failed': return 'Failed';
		default: return job.status;
	}
});

const backfillStatusVariant = computed(() => {
	const job = backfillJob.value;
	if (!job) return 'neutral';
	switch (job.status) {
		case 'running':
		case 'pending': return 'brand';
		case 'completed': return 'success';
		case 'cancelled': return 'neutral';
		case 'failed': return 'danger';
		default: return 'neutral';
	}
});

// Form state
const form = reactive({
	enabled: false,
	autoReplyEnabled: false,
	confidenceThreshold: 0.7,
	maxDailyAutoReplies: 50,
	toneDescription: '',
	signatureTemplate: '',
	coalesceWindowMs: 30000,
});

const isSaving = ref(false);
const isFormDirty = ref(false);

// Sync form when config loads
watch(config, (newConfig) => {
	if (newConfig) {
		form.autoReplyEnabled = newConfig.isAutoReplyEnabled ?? false;
		form.confidenceThreshold = newConfig.confidenceThreshold ?? 0.7;
		form.maxDailyAutoReplies = newConfig.maxDailyAutoReplies ?? 50;
		form.toneDescription = newConfig.toneDescription ?? '';
		form.signatureTemplate = newConfig.signatureTemplate ?? '';
		form.coalesceWindowMs = newConfig.coalesceWindowMs ?? 30000;
		isFormDirty.value = false;
	}
}, { immediate: true });

// Mirror the `ai.agent` flag into the form toggle
watch(
	() => flags.value['ai.agent'],
	(enabled) => {
		form.enabled = enabled === true;
	},
	{ immediate: true }
);

// Track dirty state
watch(form, () => {
	const agentFlag = flags.value['ai.agent'] === true;
	if (!config.value) {
		isFormDirty.value = form.enabled !== agentFlag;
		return;
	}
	isFormDirty.value =
		form.enabled !== agentFlag ||
		form.autoReplyEnabled !== (config.value.isAutoReplyEnabled ?? false) ||
		form.confidenceThreshold !== (config.value.confidenceThreshold ?? 0.7) ||
		form.maxDailyAutoReplies !== (config.value.maxDailyAutoReplies ?? 50) ||
		form.toneDescription !== (config.value.toneDescription ?? '') ||
		form.signatureTemplate !== (config.value.signatureTemplate ?? '') ||
		form.coalesceWindowMs !== (config.value.coalesceWindowMs ?? 30000);
}, { deep: true });

// Toast notifications (global)
const { showToast } = useToast();

// Save handler
const handleSave = async () => {
	isSaving.value = true;

	// Tuning fields go through agentConfig
	const configResult = await updateConfig({
		isAutoReplyEnabled: form.autoReplyEnabled,
		confidenceThreshold: form.confidenceThreshold,
		maxDailyAutoReplies: form.maxDailyAutoReplies,
		toneDescription: form.toneDescription || undefined,
		signatureTemplate: form.signatureTemplate || undefined,
		coalesceWindowMs: form.coalesceWindowMs,
	});
	if (configResult === undefined) {
		isSaving.value = false;
		return;
	}

	// On/off goes through the feature flag (triggers the one-shot
	// knowledge-backfill the first time it flips on)
	const agentFlag = flags.value['ai.agent'] === true;
	if (form.enabled !== agentFlag) {
		if ((await setFeatureFlag({ flag: 'ai.agent', value: form.enabled })) === undefined) {
			isSaving.value = false;
			return;
		}
	}

	isSaving.value = false;
	isFormDirty.value = false;
	showToast('Agent settings saved successfully');
};

// Confidence threshold display
const confidencePercent = computed(() => Math.round(form.confidenceThreshold * 100));
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Back Navigation -->
		<NuxtLink
			to="/dashboard/settings"
			class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors mb-6"
		>
			<Icon name="lucide:arrow-left" class="w-4 h-4" />
			Back to Settings
		</NuxtLink>

		<!-- Header -->
		<div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-8">
			<div class="flex items-center gap-4">
				<UiIconBox icon="lucide:bot" size="xl" variant="brand" rounded="full" />
				<div>
					<h1 class="text-2xl font-semibold text-text-primary">AI Agent</h1>
					<p class="text-text-secondary mt-1">
						Configure how the AI agent processes inbound messages and generates drafts.
					</p>
				</div>
			</div>

			<button
				class="btn btn-primary gap-2"
				:disabled="!isFormDirty || isSaving"
				@click="handleSave"
			>
				<div
					v-if="isSaving"
					class="w-4 h-4 border-2 border-bg-deep border-t-transparent rounded-full animate-spin"
				/>
				<Icon v-else name="lucide:save" class="w-4 h-4" />
				Save Changes
			</button>
		</div>

		<!-- Loading State -->
		<div v-if="isLoading" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">Loading agent settings...</p>
			</div>
		</div>

		<template v-else>
			<div class="space-y-6 max-w-3xl">
				<!-- Enable/Disable Section -->
				<div class="card">
					<h2 class="text-lg font-medium text-text-primary mb-1">Agent Pipeline</h2>
					<p class="text-sm text-text-secondary mb-6">
						Control whether the AI agent processes inbound messages.
					</p>

					<div class="space-y-4">
						<div class="flex items-center justify-between">
							<div>
								<p class="text-text-primary font-medium">Enable Agent Pipeline</p>
								<p class="text-sm text-text-tertiary">
									When enabled, inbound messages are classified and drafted automatically.
								</p>
							</div>
							<UiSwitch v-model="form.enabled" label="Enable AI agent" />
						</div>

						<div class="flex items-center justify-between">
							<div>
								<p class="text-text-primary font-medium">Auto-Reply</p>
								<p class="text-sm text-text-tertiary">
									Allow the agent to send replies without human approval when confidence is above threshold.
								</p>
							</div>
							<UiSwitch v-model="form.autoReplyEnabled" :disabled="!form.enabled" label="Auto-reply" />
						</div>
					</div>
				</div>

				<!-- Knowledge Backfill Section (only visible when a job exists) -->
				<div v-if="backfillJob" class="card">
					<div class="flex items-start justify-between gap-4 mb-1">
						<div>
							<h2 class="text-lg font-medium text-text-primary mb-1">Knowledge Backfill</h2>
							<p class="text-sm text-text-secondary">
								One-time scan of your inbound mail history to seed the AI agent with context.
							</p>
						</div>
						<span
							:class="[
								'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap',
								backfillStatusVariant === 'brand' && 'bg-brand-subtle text-brand',
								backfillStatusVariant === 'success' && 'bg-success-subtle text-success',
								backfillStatusVariant === 'danger' && 'bg-error-subtle text-error',
								backfillStatusVariant === 'neutral' && 'bg-bg-surface text-text-secondary',
							]"
						>
							{{ backfillStatusLabel }}
						</span>
					</div>

					<div class="mt-6 space-y-3">
						<!-- Progress bar -->
						<div>
							<div class="flex items-center justify-between text-sm mb-1">
								<span class="text-text-secondary">
									{{ backfillJob.scannedCount }} / {{ backfillJob.totalCount }} messages
								</span>
								<span class="font-mono text-text-tertiary">{{ backfillProgressPercent }}%</span>
							</div>
							<UiProgressBar size="sm" :value="backfillProgressPercent" aria-label="Knowledge backfill progress" />
						</div>

						<!-- Counters -->
						<div class="grid grid-cols-3 gap-3 text-xs">
							<div class="rounded-lg bg-bg-surface px-3 py-2">
								<div class="text-text-tertiary">Extracted</div>
								<div class="font-mono text-text-primary text-base">{{ backfillJob.extractedCount }}</div>
							</div>
							<div class="rounded-lg bg-bg-surface px-3 py-2">
								<div class="text-text-tertiary">Skipped</div>
								<div class="font-mono text-text-primary text-base">{{ backfillJob.skippedCount }}</div>
							</div>
							<div class="rounded-lg bg-bg-surface px-3 py-2">
								<div class="text-text-tertiary">Errors</div>
								<div class="font-mono text-text-primary text-base">{{ backfillJob.errorCount }}</div>
							</div>
						</div>

						<!-- Cancel (only when running/pending) -->
						<div
							v-if="backfillJob.status === 'running' || backfillJob.status === 'pending'"
							class="pt-2"
						>
							<button
								type="button"
								class="btn btn-secondary text-sm gap-2"
								:disabled="isCancellingBackfill"
								@click="handleCancelBackfill"
							>
								<div
									v-if="isCancellingBackfill"
									class="w-3.5 h-3.5 border-2 border-text-secondary border-t-transparent rounded-full animate-spin"
								/>
								<Icon v-else name="lucide:x" class="w-3.5 h-3.5" />
								Cancel Backfill
							</button>
						</div>

						<!-- Error message (failed only) -->
						<div
							v-if="backfillJob.status === 'failed' && backfillJob.errorMessage"
							class="text-sm text-error bg-error-subtle/50 rounded-lg px-3 py-2"
						>
							{{ backfillJob.errorMessage }}
						</div>
					</div>
				</div>

				<!-- Confidence & Limits Section -->
				<div class="card">
					<h2 class="text-lg font-medium text-text-primary mb-1">Confidence & Limits</h2>
					<p class="text-sm text-text-secondary mb-6">
						Set thresholds for auto-approval and rate limits.
					</p>

					<div class="space-y-6">
						<!-- Confidence Threshold -->
						<div>
							<div class="flex items-center justify-between mb-2">
								<label class="text-text-primary font-medium">Confidence Threshold</label>
								<span class="text-sm font-mono text-brand bg-brand-subtle px-2 py-0.5 rounded">
									{{ confidencePercent }}%
								</span>
							</div>
							<p class="text-sm text-text-tertiary mb-3">
								Minimum confidence score required for auto-approval. Drafts below this threshold go to the review queue.
							</p>
							<input
								v-model.number="form.confidenceThreshold"
								type="range"
								min="0"
								max="1"
								step="0.05"
								class="w-full h-2 bg-bg-surface rounded-lg appearance-none cursor-pointer accent-brand"
							/>
							<div class="flex justify-between text-xs text-text-tertiary mt-1">
								<span>0% (all to review)</span>
								<span>100% (never auto-approve)</span>
							</div>
						</div>

						<!-- Daily Auto-Reply Limit -->
						<div>
							<label class="text-text-primary font-medium">Daily Auto-Reply Limit</label>
							<p class="text-sm text-text-tertiary mt-1 mb-3">
								Maximum number of auto-approved replies per day. Excess messages go to the review queue.
							</p>
							<input
								v-model.number="form.maxDailyAutoReplies"
								type="number"
								min="0"
								max="10000"
								class="input w-40"
								placeholder="50"
							/>
						</div>

						<!-- Coalescing Window -->
						<div>
							<label class="text-text-primary font-medium">Message Coalescing Window</label>
							<p class="text-sm text-text-tertiary mt-1 mb-3">
								Wait this many seconds for additional messages before processing a thread.
								Prevents redundant processing of rapid message bursts.
							</p>
							<div class="flex items-center gap-3">
								<input
									:value="form.coalesceWindowMs / 1000"
									type="number"
									min="0"
									max="300"
									class="input w-40"
									placeholder="30"
									@input="form.coalesceWindowMs = Number(($event.target as HTMLInputElement).value) * 1000"
								/>
								<span class="text-text-secondary text-sm">seconds</span>
							</div>
						</div>
					</div>
				</div>

				<!-- Tone & Signature Section -->
				<div class="card">
					<h2 class="text-lg font-medium text-text-primary mb-1">Tone & Signature</h2>
					<p class="text-sm text-text-secondary mb-6">
						Define how the agent communicates on behalf of your workspace.
					</p>

					<div class="space-y-6">
						<!-- Tone Description -->
						<div>
							<label class="text-text-primary font-medium">Tone Description</label>
							<p class="text-sm text-text-tertiary mt-1 mb-3">
								Describe the communication style for agent-generated drafts.
							</p>
							<textarea
								v-model="form.toneDescription"
								rows="4"
								class="input w-full resize-y"
								placeholder="e.g., Professional and friendly. Use the customer's first name. Keep responses concise but thorough."
							/>
						</div>

						<!-- Signature Template -->
						<div>
							<label class="text-text-primary font-medium">Email Signature</label>
							<p class="text-sm text-text-tertiary mt-1 mb-3">
								Signature appended to agent-generated email replies.
							</p>
							<textarea
								v-model="form.signatureTemplate"
								rows="4"
								class="input w-full resize-y"
								placeholder="e.g., Best regards,&#10;The Support Team&#10;support@yourcompany.com"
							/>
						</div>
					</div>
				</div>

				<!-- Save Button (bottom) -->
				<div class="flex justify-end pt-2">
					<button
						class="btn btn-primary gap-2"
						:disabled="!isFormDirty || isSaving"
						@click="handleSave"
					>
						<div
							v-if="isSaving"
							class="w-4 h-4 border-2 border-bg-deep border-t-transparent rounded-full animate-spin"
						/>
						<Icon v-else name="lucide:save" class="w-4 h-4" />
						Save Changes
					</button>
				</div>
			</div>
		</template>
	</div>
</template>
