<script setup lang="ts">
/**
 * AI replies — the one page that decides whether the AI drafts replies, sends
 * them on its own, or stays off.
 *
 * It replaces two pages that each held half of the answer (AI agent: an
 * Auto-reply switch, threshold and limit; Autonomy rules: per-category rules,
 * a separate stop button and working hours), plus a shadow-mode setting no page
 * could reach. The top control is mapped onto all of them by
 * `~/utils/aiReplyMode`; the per-category rules stay behind the
 * `ai.autonomy` feature flag, whose state is shown here with a link to Features.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { UnsavedChangesDialog } from '@owlat/email-builder';
import AiReplyModeControl from '~/components/settings/AiReplyModeControl.vue';
import {
	deriveAiReplyMode,
	planAiReplyModeChange,
	type AiReplyMode,
	type AiReplySettings,
} from '~/utils/aiReplyMode';

definePageMeta({
	layout: 'admin',
	middleware: ['auth', 'admin'],
	// Deliberately ungated: "Off" turns `ai.agent` off, and this is the page
	// that turns it back on.
});

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.instance.aiReplies.pageTitle') });

const FEATURES_PATH = '/dashboard/admin/instance/features';

const { flags } = useFeatureFlag();
const agentEnabled = computed(() => flags.value['ai.agent'] === true);
const rulesEnabled = computed(() => flags.value['ai.autonomy'] === true);
// `ai.agent` requires both; while either is off only "Off" can be chosen here.
const canTurnOn = computed(() => flags.value['ai'] === true && flags.value['inbox'] === true);

const { data: config, isLoading } = useConvexQuery(api.agentConfigMutations.getConfig, () => ({}));

const settings = computed<AiReplySettings>(() => ({
	agentEnabled: agentEnabled.value,
	rulesEnabled: rulesEnabled.value,
	config: config.value,
}));
const mode = computed(() => deriveAiReplyMode(settings.value));

// ─── The top control ────────────────────────────────────────────────────────

const { run: setFeatureFlag } = useBackendOperation(api.workspaces.featureFlags.setFeatureFlag, {
	label: () => t('dashboard.admin.instance.aiReplies.operations.setMode'),
});
const { run: setReplyMode } = useBackendOperation(api.agentConfigMutations.setReplyMode, {
	label: () => t('dashboard.admin.instance.aiReplies.operations.setMode'),
});

const { showToast } = useToast();

// Shown as selected while the writes run, so the radio follows the click and
// snaps back if a write fails.
const pendingMode = ref<AiReplyMode | null>(null);

async function selectMode(target: AiReplyMode) {
	if (pendingMode.value) return;
	const steps = planAiReplyModeChange(settings.value, target);
	if (steps.length === 0) return;
	pendingMode.value = target;
	try {
		for (const step of steps) {
			const result =
				step.kind === 'agentFlag'
					? await setFeatureFlag({ flag: 'ai.agent', value: step.value })
					: await setReplyMode({ mode: step.mode });
			if (!result.ok) return; // failure already toasted by the operation module
		}
		showToast(t(`dashboard.admin.instance.aiReplies.toasts.mode.${target}`));
	} finally {
		pendingMode.value = null;
	}
}

// ─── Tuning form: threshold, limit, tone, signature, follow-up wait ─────────

const { run: updateConfig } = useBackendOperation(api.agentConfigMutations.updateConfig, {
	label: () => t('dashboard.admin.instance.aiReplies.operations.save'),
});

const DEFAULTS = {
	confidenceThreshold: 0.7,
	maxDailyAutoReplies: 50,
	toneDescription: '',
	signatureTemplate: '',
	coalesceWindowMs: 30000,
};

const form = reactive({ ...DEFAULTS });

function stored() {
	const c = config.value;
	return {
		confidenceThreshold: c?.confidenceThreshold ?? DEFAULTS.confidenceThreshold,
		maxDailyAutoReplies: c?.maxDailyAutoReplies ?? DEFAULTS.maxDailyAutoReplies,
		toneDescription: c?.toneDescription ?? DEFAULTS.toneDescription,
		signatureTemplate: c?.signatureTemplate ?? DEFAULTS.signatureTemplate,
		coalesceWindowMs: c?.coalesceWindowMs ?? DEFAULTS.coalesceWindowMs,
	};
}

watch(config, () => Object.assign(form, stored()), { immediate: true });

const isFormDirty = computed(() => {
	const s = stored();
	return (Object.keys(s) as (keyof typeof s)[]).some((key) => form[key] !== s[key]);
});

const isSaving = ref(false);

// Resolves to whether the save succeeded, so the unsaved-changes guard keeps
// the admin (and their edits) on the page when it fails.
const handleSave = async (): Promise<boolean> => {
	isSaving.value = true;
	try {
		const result = await updateConfig({
			confidenceThreshold: form.confidenceThreshold,
			maxDailyAutoReplies: form.maxDailyAutoReplies,
			toneDescription: form.toneDescription || undefined,
			signatureTemplate: form.signatureTemplate || undefined,
			coalesceWindowMs: form.coalesceWindowMs,
		});
		if (!result.ok) return false;
		showToast(t('dashboard.admin.instance.aiReplies.toasts.saved'));
		return true;
	} finally {
		isSaving.value = false;
	}
};

// Unsaved-changes guard: in-app navigation while the form is dirty prompts to
// save or discard instead of silently dropping the edits. `onSave` throws on
// failure so a failed save keeps the admin here.
const {
	showDialog: showUnsavedDialog,
	confirmDiscard,
	confirmSave,
	cancelNavigation,
	setHasChanges,
} = useUnsavedChanges({
	onSave: async () => {
		if (!(await handleSave())) throw new Error('Save failed');
	},
});

watch(isFormDirty, (dirty) => setHasChanges(dirty), { immediate: true });

const confidencePercent = computed(() => Math.round(form.confidenceThreshold * 100));

// ─── Working hours ──────────────────────────────────────────────────────────

const { run: runUpdateWorkingHours } = useBackendOperation(api.agentConfigMutations.updateConfig, {
	label: () => t('dashboard.admin.instance.aiReplies.operations.saveWorkingHours'),
});
const workingHoursBusy = ref(false);

async function handleSaveWorkingHours(payload: {
	enabled: boolean;
	timezone: string;
	start: number;
	end: number;
	days: number[];
}) {
	workingHoursBusy.value = true;
	try {
		const result = await runUpdateWorkingHours({
			isWorkingHoursEnabled: payload.enabled,
			workingHoursTimezone: payload.timezone,
			workingHoursStart: payload.start,
			workingHoursEnd: payload.end,
			workingHoursDays: payload.days,
		});
		if (!result.ok) return;
		showToast(t('dashboard.admin.instance.aiReplies.toasts.workingHoursSaved'));
	} finally {
		workingHoursBusy.value = false;
	}
}

// ─── Per-category rules (ai.autonomy) ───────────────────────────────────────

// Every one of these asserts `ai.autonomy` server-side, so they only subscribe
// while the rules are on.
const whenRules = () => (rulesEnabled.value && agentEnabled.value ? {} : ('skip' as const));
const {
	data: rules,
	isLoading: rulesLoading,
	error: rulesError,
} = useConvexQuery(api.autonomy.listRules, whenRules);
const { data: scorecard } = useConvexQuery(api.agent.shadowScorecard.getShadowScorecard, whenRules);
const { data: suggestions } = useConvexQuery(
	api.autonomySuggestions.listGraduationSuggestions,
	whenRules
);
const { data: demotions } = useConvexQuery(api.autonomyOutcome.listAutoDemotions, whenRules);
const { data: feedbackStats } = useConvexQuery(api.autonomyFeedback.getFeedbackStats, () =>
	agentEnabled.value ? { hoursBack: 24 } : 'skip'
);

const { run: runSetSenderAutonomy } = useBackendOperation(api.autonomy.setSenderAutonomy, {
	label: () => t('dashboard.admin.instance.aiReplies.operations.enableSender'),
});
const { run: runAcceptSuggestion } = useBackendOperation(
	api.autonomySuggestions.acceptGraduationSuggestion,
	{ label: () => t('dashboard.admin.instance.aiReplies.operations.applySuggestion') }
);
const { run: runAcknowledgeDemotion } = useBackendOperation(
	api.autonomyOutcome.acknowledgeAutoDemotion,
	{ label: () => t('dashboard.admin.instance.aiReplies.operations.dismissDemotion') }
);

const nudgePendingKey = ref<string | null>(null);
const demotionPendingId = ref<string | null>(null);

const CATEGORIES = [
	'support',
	'sales',
	'billing',
	'feature_request',
	'complaint',
	'spam',
	'internal',
	'other',
] as const;

const isAddingRule = ref(false);
const newRule = {
	_id: '',
	category: '',
	autoApproveThreshold: 0.7,
	maxDailyAutoActions: 50,
	isEnabled: true,
};
const hasAvailableCategories = computed(() => {
	const used = new Set((rules.value ?? []).map((r) => r.category));
	return CATEGORIES.some((c) => !used.has(c));
});

function handleRuleSaved() {
	isAddingRule.value = false;
	showToast(t('dashboard.admin.instance.aiReplies.toasts.ruleSaved'));
}

function handleRuleDeleted() {
	showToast(t('dashboard.admin.instance.aiReplies.toasts.ruleDeleted'));
}

async function handleAcceptOffer(payload: { category: string; sender: string }) {
	nudgePendingKey.value = `${payload.category}::${payload.sender}`;
	try {
		const result = await runSetSenderAutonomy({
			category: payload.category,
			sender: payload.sender,
			isEnabled: true,
		});
		if (!result.ok) return;
		showToast(
			t('dashboard.admin.instance.aiReplies.toasts.senderEnabled', { sender: payload.sender })
		);
	} finally {
		nudgePendingKey.value = null;
	}
}

async function handleAcceptSuggestion(payload: { suggestionId: string }) {
	nudgePendingKey.value = payload.suggestionId;
	try {
		const result = await runAcceptSuggestion({
			suggestionId: payload.suggestionId as Id<'autonomySuggestions'>,
		});
		if (!result.ok) return;
		showToast(t('dashboard.admin.instance.aiReplies.toasts.suggestionApplied'));
	} finally {
		nudgePendingKey.value = null;
	}
}

async function handleAcknowledgeDemotion(payload: { ruleId: string }) {
	demotionPendingId.value = payload.ruleId;
	try {
		const result = await runAcknowledgeDemotion({
			ruleId: payload.ruleId as Id<'autonomyRules'>,
		});
		if (!result.ok) return;
		showToast(t('dashboard.admin.instance.aiReplies.toasts.alertDismissed'));
	} finally {
		demotionPendingId.value = null;
	}
}
</script>

<template>
	<div class="p-6 lg:p-8">
		<div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-8">
			<div class="flex items-center gap-4">
				<UiIconBox icon="lucide:bot" size="xl" variant="brand" rounded="full" />
				<div>
					<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
						{{ t('dashboard.admin.instance.aiReplies.title') }}
					</h1>
					<p class="text-text-secondary mt-1 max-w-xl">
						{{ t('dashboard.admin.instance.aiReplies.subtitle') }}
					</p>
				</div>
			</div>
		</div>

		<div
			v-if="isLoading"
			class="space-y-6 max-w-3xl"
			role="status"
			aria-busy="true"
			:aria-label="t('dashboard.admin.instance.aiReplies.loading')"
		>
			<div v-for="card in 3" :key="card" class="card space-y-4">
				<UiSkeleton class="h-5 w-48" />
				<UiSkeletonText :lines="2" size="sm" last-line-width="w-1/2" />
				<UiSkeleton v-for="row in 2" :key="row" class="h-10 rounded-lg" />
			</div>
		</div>

		<div v-else class="space-y-6 max-w-3xl">
			<!-- The one control -->
			<section class="card" aria-labelledby="ai-replies-mode-heading">
				<div class="flex items-start justify-between gap-4 mb-4">
					<div>
						<h2 id="ai-replies-mode-heading" class="text-lg font-medium text-text-primary">
							{{ t('dashboard.admin.instance.aiReplies.mode.title') }}
						</h2>
						<p class="text-sm text-text-secondary mt-1">
							{{ t('dashboard.admin.instance.aiReplies.mode.description') }}
						</p>
					</div>
					<UiSpinner v-if="pendingMode" size="xs" />
				</div>

				<AiReplyModeControl
					:mode="pendingMode ?? mode"
					:busy="pendingMode !== null"
					:can-turn-on="canTurnOn"
					@select="selectMode"
				/>

				<p
					v-if="!canTurnOn"
					class="mt-4 text-sm text-text-secondary"
					data-testid="ai-replies-needs-features"
				>
					{{ t('dashboard.admin.instance.aiReplies.mode.needsFeatures') }}
					<NuxtLink :to="FEATURES_PATH" class="text-brand hover:underline font-medium">
						{{ t('dashboard.admin.instance.aiReplies.openFeatures') }}
					</NuxtLink>
				</p>

				<!-- The ai.autonomy flag: shown here, changed on Features -->
				<div
					class="mt-4 pt-4 border-t border-border-subtle flex flex-wrap items-center justify-between gap-2 text-sm"
					data-testid="ai-replies-rules-flag"
				>
					<span class="text-text-secondary">
						{{ t('dashboard.admin.instance.aiReplies.rulesFlag.label') }}
						<span class="font-medium text-text-primary">
							{{
								rulesEnabled
									? t('dashboard.admin.instance.aiReplies.rulesFlag.on')
									: t('dashboard.admin.instance.aiReplies.rulesFlag.off')
							}}
						</span>
					</span>
					<NuxtLink :to="FEATURES_PATH" class="text-brand hover:underline font-medium">
						{{ t('dashboard.admin.instance.aiReplies.rulesFlag.change') }}
					</NuxtLink>
				</div>
			</section>

			<!-- When to send: only meaningful while sending automatically -->
			<section
				v-if="mode === 'auto'"
				class="card"
				aria-labelledby="ai-replies-when-heading"
				data-testid="ai-replies-when"
			>
				<h2 id="ai-replies-when-heading" class="text-lg font-medium text-text-primary mb-1">
					{{ t('dashboard.admin.instance.aiReplies.when.title') }}
				</h2>

				<p v-if="rulesEnabled" class="text-sm text-text-secondary">
					{{ t('dashboard.admin.instance.aiReplies.when.byRule') }}
				</p>
				<div v-else class="space-y-6 mt-4">
					<div>
						<div class="flex items-center justify-between mb-2">
							<label for="ai-replies-threshold" class="text-text-primary font-medium">
								{{ t('dashboard.admin.instance.aiReplies.when.thresholdLabel') }}
							</label>
							<span class="text-sm font-mono text-brand bg-brand-subtle px-2 py-0.5 rounded">
								{{ confidencePercent }}%
							</span>
						</div>
						<p class="text-sm text-text-tertiary mb-3">
							{{ t('dashboard.admin.instance.aiReplies.when.thresholdHelp') }}
						</p>
						<input
							id="ai-replies-threshold"
							v-model.number="form.confidenceThreshold"
							type="range"
							min="0"
							max="1"
							step="0.05"
							class="w-full h-2 bg-bg-surface rounded-lg appearance-none cursor-pointer accent-brand"
						/>
						<div class="flex justify-between text-xs text-text-tertiary mt-1">
							<span>{{ t('dashboard.admin.instance.aiReplies.when.thresholdMin') }}</span>
							<span>{{ t('dashboard.admin.instance.aiReplies.when.thresholdMax') }}</span>
						</div>
					</div>

					<div>
						<label for="ai-replies-daily" class="text-text-primary font-medium">
							{{ t('dashboard.admin.instance.aiReplies.when.dailyLabel') }}
						</label>
						<p class="text-sm text-text-tertiary mt-1 mb-3">
							{{ t('dashboard.admin.instance.aiReplies.when.dailyHelp') }}
						</p>
						<input
							id="ai-replies-daily"
							v-model.number="form.maxDailyAutoReplies"
							type="number"
							min="0"
							max="10000"
							class="input w-40"
							placeholder="50"
						/>
					</div>

					<div class="flex justify-end">
						<UiButton class="gap-2" :disabled="!isFormDirty || isSaving" @click="handleSave">
							<UiSpinner v-if="isSaving" size="xs" tone="inverse" />
							<Icon v-else name="lucide:save" class="w-4 h-4" />
							{{ t('dashboard.admin.instance.aiReplies.saveChanges') }}
						</UiButton>
					</div>
				</div>
			</section>

			<AutonomyWorkingHours
				v-if="mode === 'auto'"
				:enabled="config?.isWorkingHoursEnabled ?? false"
				:timezone="config?.workingHoursTimezone ?? ''"
				:start="config?.workingHoursStart ?? 540"
				:end="config?.workingHoursEnd ?? 1020"
				:days="config?.workingHoursDays ?? [1, 2, 3, 4, 5]"
				:busy="workingHoursBusy"
				@save="handleSaveWorkingHours"
			/>

			<!-- Rules: per type of message, and in plain words -->
			<template v-if="agentEnabled">
				<section
					v-if="rulesEnabled"
					class="space-y-4"
					aria-labelledby="ai-replies-rules-heading"
					data-testid="ai-replies-rules"
				>
					<div class="flex flex-wrap items-start justify-between gap-4">
						<div>
							<h2 id="ai-replies-rules-heading" class="text-lg font-medium text-text-primary">
								{{ t('dashboard.admin.instance.aiReplies.rules.title') }}
							</h2>
							<p class="text-sm text-text-secondary mt-1 max-w-xl">
								{{
									mode === 'auto'
										? t('dashboard.admin.instance.aiReplies.rules.description')
										: t('dashboard.admin.instance.aiReplies.rules.draftOnlyNote')
								}}
							</p>
						</div>
						<UiButton
							v-if="hasAvailableCategories && rules?.length"
							variant="secondary"
							class="gap-2"
							:disabled="isAddingRule"
							@click="isAddingRule = true"
						>
							<Icon name="lucide:plus" class="w-4 h-4" />
							{{ t('dashboard.admin.instance.aiReplies.rules.add') }}
						</UiButton>
					</div>

					<div v-if="rulesLoading" class="flex items-center justify-center py-8">
						<UiSpinner />
					</div>
					<UiErrorAlert
						v-else-if="rulesError"
						:title="t('dashboard.admin.instance.aiReplies.rules.errorTitle')"
						:message="t('dashboard.admin.instance.aiReplies.rules.errorMessage')"
					/>
					<template v-else>
						<AutonomyDemotionAlerts
							:incidents="demotions ?? []"
							:pending-id="demotionPendingId"
							@acknowledge="handleAcknowledgeDemotion"
						/>
						<AutonomyGraduationNudge
							:offers="scorecard ?? []"
							:suggestions="suggestions ?? []"
							:pending-key="nudgePendingKey"
							@accept-offer="handleAcceptOffer"
							@accept-suggestion="handleAcceptSuggestion"
						/>
						<AutonomyRuleEditor
							v-if="isAddingRule"
							:rule="newRule"
							:is-new="true"
							@saved="handleRuleSaved"
							@cancelled="isAddingRule = false"
						/>
						<AutonomyRuleEditor
							v-for="rule in rules"
							:key="rule._id"
							:rule="rule"
							@saved="handleRuleSaved"
							@deleted="handleRuleDeleted"
						/>
						<UiCard v-if="!rules?.length && !isAddingRule">
							<div class="py-6 text-center">
								<h3 class="text-base font-medium text-text-primary mb-2">
									{{ t('dashboard.admin.instance.aiReplies.rules.emptyTitle') }}
								</h3>
								<p class="text-sm text-text-tertiary mb-4 max-w-sm mx-auto">
									{{ t('dashboard.admin.instance.aiReplies.rules.emptyBody') }}
								</p>
								<UiButton class="gap-2" @click="isAddingRule = true">
									<Icon name="lucide:plus" class="w-4 h-4" />
									{{ t('dashboard.admin.instance.aiReplies.rules.add') }}
								</UiButton>
							</div>
						</UiCard>
					</template>

					<UiCard>
						<AutonomyHandlingRulesManager />
					</UiCard>
				</section>

				<section v-else class="card" data-testid="ai-replies-rules-off">
					<h2 class="text-lg font-medium text-text-primary mb-1">
						{{ t('dashboard.admin.instance.aiReplies.rules.title') }}
					</h2>
					<p class="text-sm text-text-secondary">
						{{ t('dashboard.admin.instance.aiReplies.rules.offBody') }}
						<NuxtLink :to="FEATURES_PATH" class="text-brand hover:underline font-medium">
							{{ t('dashboard.admin.instance.aiReplies.openFeatures') }}
						</NuxtLink>
					</p>
				</section>
			</template>

			<!-- How replies read -->
			<section class="card" aria-labelledby="ai-replies-tone-heading">
				<h2 id="ai-replies-tone-heading" class="text-lg font-medium text-text-primary mb-1">
					{{ t('dashboard.admin.instance.aiReplies.tone.title') }}
				</h2>
				<p class="text-sm text-text-secondary mb-6">
					{{ t('dashboard.admin.instance.aiReplies.tone.description') }}
				</p>

				<div class="space-y-6">
					<div>
						<label for="ai-replies-tone" class="text-text-primary font-medium">
							{{ t('dashboard.admin.instance.aiReplies.tone.toneLabel') }}
						</label>
						<p class="text-sm text-text-tertiary mt-1 mb-3">
							{{ t('dashboard.admin.instance.aiReplies.tone.toneHelp') }}
						</p>
						<textarea
							id="ai-replies-tone"
							v-model="form.toneDescription"
							rows="4"
							class="input w-full resize-y"
							:placeholder="t('dashboard.admin.instance.aiReplies.tone.tonePlaceholder')"
						/>
					</div>

					<div>
						<label for="ai-replies-signature" class="text-text-primary font-medium">
							{{ t('dashboard.admin.instance.aiReplies.tone.signatureLabel') }}
						</label>
						<p class="text-sm text-text-tertiary mt-1 mb-3">
							{{ t('dashboard.admin.instance.aiReplies.tone.signatureHelp') }}
						</p>
						<textarea
							id="ai-replies-signature"
							v-model="form.signatureTemplate"
							rows="4"
							class="input w-full resize-y"
							:placeholder="t('dashboard.admin.instance.aiReplies.tone.signaturePlaceholder')"
						/>
					</div>

					<div>
						<label for="ai-replies-coalesce" class="text-text-primary font-medium">
							{{ t('dashboard.admin.instance.aiReplies.tone.coalesceLabel') }}
						</label>
						<p class="text-sm text-text-tertiary mt-1 mb-3">
							{{ t('dashboard.admin.instance.aiReplies.tone.coalesceHelp') }}
						</p>
						<div class="flex items-center gap-3">
							<input
								id="ai-replies-coalesce"
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
								{{ t('dashboard.admin.instance.aiReplies.tone.seconds') }}
							</span>
						</div>
					</div>
				</div>

				<div class="flex justify-end mt-6">
					<UiButton class="gap-2" :disabled="!isFormDirty || isSaving" @click="handleSave">
						<UiSpinner v-if="isSaving" size="xs" tone="inverse" />
						<Icon v-else name="lucide:save" class="w-4 h-4" />
						{{ t('dashboard.admin.instance.aiReplies.saveChanges') }}
					</UiButton>
				</div>
			</section>

			<template v-if="agentEnabled">
				<AgentKnowledgeBackfillCard />
				<AgentKnowledgeRelationBackfillCard />
				<AutonomyAskEagernessDial />
				<AutonomyFeedbackStatsCard :stats="feedbackStats ?? null" />
				<AutonomyLearningControls />
			</template>
		</div>

		<UnsavedChangesDialog
			:show="showUnsavedDialog"
			@close="cancelNavigation"
			@discard="confirmDiscard"
			@save="confirmSave"
		/>
	</div>
</template>
