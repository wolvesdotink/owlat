<script setup lang="ts">
import { api } from '@owlat/api';

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.instance.agent.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: ['auth', 'admin'],
	// Gate by URL too — the nav hides this link when ai.agent is off; re-enable
	// via the always-on Features settings page.
	requiresFeature: 'ai.agent',
});

// Agent on/off is the `ai.agent` feature flag — not a column on agentConfig.
const { flags } = useFeatureFlag();
const { run: setFeatureFlag } = useBackendOperation(api.workspaces.featureFlags.setFeatureFlag, {
	label: () => t('dashboard.admin.instance.agent.toggleOperation'),
});

// Fetch current operational tuning (threshold, tone, signature, …)
const { data: config, isLoading } = useConvexQuery(api.agentConfigMutations.getConfig, () => ({}));
const { run: updateConfig } = useBackendOperation(api.agentConfigMutations.updateConfig, {
	label: () => t('dashboard.admin.instance.agent.saveOperation'),
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
watch(
	config,
	(newConfig) => {
		if (newConfig) {
			form.autoReplyEnabled = newConfig.isAutoReplyEnabled ?? false;
			form.confidenceThreshold = newConfig.confidenceThreshold ?? 0.7;
			form.maxDailyAutoReplies = newConfig.maxDailyAutoReplies ?? 50;
			form.toneDescription = newConfig.toneDescription ?? '';
			form.signatureTemplate = newConfig.signatureTemplate ?? '';
			form.coalesceWindowMs = newConfig.coalesceWindowMs ?? 30000;
			isFormDirty.value = false;
		}
	},
	{ immediate: true }
);

// Mirror the `ai.agent` flag into the form toggle
watch(
	() => flags.value['ai.agent'],
	(enabled) => {
		form.enabled = enabled === true;
	},
	{ immediate: true }
);

// Track dirty state
watch(
	form,
	() => {
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
	},
	{ deep: true }
);

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
	showToast(t('dashboard.admin.instance.agent.savedToast'));
};

// Confidence threshold display
const confidencePercent = computed(() => Math.round(form.confidenceThreshold * 100));
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Back Navigation -->
		<NuxtLink
			to="/dashboard/admin"
			class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors mb-6"
		>
			<Icon name="lucide:arrow-left" class="w-4 h-4" />
			{{ t('dashboard.admin.instance.agent.backToSettings') }}
		</NuxtLink>

		<!-- Header -->
		<div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-8">
			<div class="flex items-center gap-4">
				<UiIconBox icon="lucide:bot" size="xl" variant="brand" rounded="full" />
				<div>
					<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
						{{ t('dashboard.admin.instance.agent.title') }}
					</h1>
					<p class="text-text-secondary mt-1">
						{{ t('dashboard.admin.instance.agent.subtitle') }}
					</p>
				</div>
			</div>

			<UiButton class="gap-2" :disabled="!isFormDirty || isSaving" @click="handleSave">
				<UiSpinner v-if="isSaving" size="xs" tone="inverse" />
				<Icon v-else name="lucide:save" class="w-4 h-4" />
				{{ t('dashboard.admin.instance.agent.saveChanges') }}
			</UiButton>
		</div>

		<!-- Loading State -->
		<div v-if="isLoading" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">
					{{ t('dashboard.admin.instance.agent.loading') }}
				</p>
			</div>
		</div>

		<template v-else>
			<div class="space-y-6 max-w-3xl">
				<!-- Enable/Disable Section -->
				<div class="card">
					<h2 class="text-lg font-medium text-text-primary mb-1">
						{{ t('dashboard.admin.instance.agent.pipeline.title') }}
					</h2>
					<p class="text-sm text-text-secondary mb-6">
						{{ t('dashboard.admin.instance.agent.pipeline.description') }}
					</p>

					<div class="space-y-4">
						<div class="flex items-center justify-between">
							<div>
								<p class="text-text-primary font-medium">
									{{ t('dashboard.admin.instance.agent.pipeline.enableLabel') }}
								</p>
								<p class="text-sm text-text-tertiary">
									{{ t('dashboard.admin.instance.agent.pipeline.enableHelp') }}
								</p>
							</div>
							<UiSwitch
								v-model="form.enabled"
								:label="t('dashboard.admin.instance.agent.pipeline.enableSwitch')"
							/>
						</div>

						<div class="flex items-center justify-between">
							<div>
								<p class="text-text-primary font-medium">
									{{ t('dashboard.admin.instance.agent.pipeline.autoReplyLabel') }}
								</p>
								<p class="text-sm text-text-tertiary">
									{{ t('dashboard.admin.instance.agent.pipeline.autoReplyHelp') }}
								</p>
							</div>
							<UiSwitch
								v-model="form.autoReplyEnabled"
								:disabled="!form.enabled"
								:label="t('dashboard.admin.instance.agent.pipeline.autoReplySwitch')"
							/>
						</div>
					</div>
				</div>

				<AgentKnowledgeBackfillCard />

				<AgentKnowledgeRelationBackfillCard />

				<!-- Confidence & Limits Section -->
				<div class="card">
					<h2 class="text-lg font-medium text-text-primary mb-1">
						{{ t('dashboard.admin.instance.agent.limits.title') }}
					</h2>
					<p class="text-sm text-text-secondary mb-6">
						{{ t('dashboard.admin.instance.agent.limits.description') }}
					</p>

					<div class="space-y-6">
						<!-- Confidence Threshold -->
						<div>
							<div class="flex items-center justify-between mb-2">
								<label class="text-text-primary font-medium">
									{{ t('dashboard.admin.instance.agent.limits.thresholdLabel') }}
								</label>
								<span class="text-sm font-mono text-brand bg-brand-subtle px-2 py-0.5 rounded">
									{{ confidencePercent }}%
								</span>
							</div>
							<p class="text-sm text-text-tertiary mb-3">
								{{ t('dashboard.admin.instance.agent.limits.thresholdHelp') }}
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
								<span>{{ t('dashboard.admin.instance.agent.limits.thresholdMin') }}</span>
								<span>{{ t('dashboard.admin.instance.agent.limits.thresholdMax') }}</span>
							</div>
						</div>

						<!-- Daily Auto-Reply Limit -->
						<div>
							<label class="text-text-primary font-medium">
								{{ t('dashboard.admin.instance.agent.limits.dailyLabel') }}
							</label>
							<p class="text-sm text-text-tertiary mt-1 mb-3">
								{{ t('dashboard.admin.instance.agent.limits.dailyHelp') }}
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
							<label class="text-text-primary font-medium">
								{{ t('dashboard.admin.instance.agent.limits.coalesceLabel') }}
							</label>
							<p class="text-sm text-text-tertiary mt-1 mb-3">
								{{ t('dashboard.admin.instance.agent.limits.coalesceHelp') }}
							</p>
							<div class="flex items-center gap-3">
								<input
									:value="form.coalesceWindowMs / 1000"
									type="number"
									min="0"
									max="300"
									class="input w-40"
									placeholder="30"
									@input="
										form.coalesceWindowMs = Number(($event.target as HTMLInputElement).value) * 1000
									"
								/>
								<span class="text-text-secondary text-sm">
									{{ t('dashboard.admin.instance.agent.limits.seconds') }}
								</span>
							</div>
						</div>
					</div>
				</div>

				<!-- Tone & Signature Section -->
				<div class="card">
					<h2 class="text-lg font-medium text-text-primary mb-1">
						{{ t('dashboard.admin.instance.agent.tone.title') }}
					</h2>
					<p class="text-sm text-text-secondary mb-6">
						{{ t('dashboard.admin.instance.agent.tone.description') }}
					</p>

					<div class="space-y-6">
						<!-- Tone Description -->
						<div>
							<label class="text-text-primary font-medium">
								{{ t('dashboard.admin.instance.agent.tone.toneLabel') }}
							</label>
							<p class="text-sm text-text-tertiary mt-1 mb-3">
								{{ t('dashboard.admin.instance.agent.tone.toneHelp') }}
							</p>
							<textarea
								v-model="form.toneDescription"
								rows="4"
								class="input w-full resize-y"
								:placeholder="t('dashboard.admin.instance.agent.tone.tonePlaceholder')"
							/>
						</div>

						<!-- Signature Template -->
						<div>
							<label class="text-text-primary font-medium">
								{{ t('dashboard.admin.instance.agent.tone.signatureLabel') }}
							</label>
							<p class="text-sm text-text-tertiary mt-1 mb-3">
								{{ t('dashboard.admin.instance.agent.tone.signatureHelp') }}
							</p>
							<textarea
								v-model="form.signatureTemplate"
								rows="4"
								class="input w-full resize-y"
								:placeholder="t('dashboard.admin.instance.agent.tone.signaturePlaceholder')"
							/>
						</div>
					</div>
				</div>

				<!-- Save Button (bottom) -->
				<div class="flex justify-end pt-2">
					<UiButton class="gap-2" :disabled="!isFormDirty || isSaving" @click="handleSave">
						<UiSpinner v-if="isSaving" size="xs" tone="inverse" />
						<Icon v-else name="lucide:save" class="w-4 h-4" />
						{{ t('dashboard.admin.instance.agent.saveChanges') }}
					</UiButton>
				</div>
			</div>
		</template>
	</div>
</template>
