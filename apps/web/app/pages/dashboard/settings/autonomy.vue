<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	// Mirror the nav gate: only reachable when ai.autonomy is enabled.
	requiresFeature: 'ai.autonomy',
});

useHead({ title: 'Autonomy Rules — Owlat' });

// Fetch existing rules
const {
	data: rules,
	isLoading: rulesLoading,
	error: rulesError,
} = useConvexQuery(api.autonomy.listRules, () => ({}));

// Fetch feedback stats for the last 24h
const { data: feedbackStats } = useConvexQuery(api.autonomyFeedback.getFeedbackStats, () => ({
	hoursBack: 24,
}));

// Graduation nudge evidence: per-sender shadow scorecard offers + category
// threshold-loosening suggestions. Both accept EXPLICITLY.
const { data: scorecard } = useConvexQuery(
	api.agent.shadowScorecard.getShadowScorecard,
	() => ({})
);
const { data: suggestions } = useConvexQuery(
	api.autonomySuggestions.listGraduationSuggestions,
	() => ({})
);

// Auto-demotion incidents (bad-outcome → draft-only).
const { data: demotions } = useConvexQuery(api.autonomyOutcome.listAutoDemotions, () => ({}));

// Agent config for the working-hours window.
const { data: agentConfig } = useConvexQuery(api.agentConfigMutations.getConfig, () => ({}));

// Mutations
const { run: runKillSwitch } = useBackendOperation(api.agentConfigMutations.killSwitch, {
	label: 'Stop auto-sending',
});
const { run: runSetSenderAutonomy } = useBackendOperation(api.autonomy.setSenderAutonomy, {
	label: 'Enable auto-send for sender',
});
const { run: runAcceptSuggestion } = useBackendOperation(
	api.autonomySuggestions.acceptGraduationSuggestion,
	{ label: 'Apply graduation suggestion' }
);
const { run: runAcknowledgeDemotion } = useBackendOperation(
	api.autonomyOutcome.acknowledgeAutoDemotion,
	{ label: 'Dismiss demotion alert' }
);
const { run: runUpdateConfig } = useBackendOperation(api.agentConfigMutations.updateConfig, {
	label: 'Save working hours',
});

const killSwitchBusy = ref(false);
const nudgePendingKey = ref<string | null>(null);
const demotionPendingId = ref<string | null>(null);
const workingHoursBusy = ref(false);

// Track which categories already have rules
const existingCategories = computed(() => {
	if (!rules.value) return new Set<string>();
	return new Set(rules.value.map((r) => r.category));
});

// New rule state
const isAddingNew = ref(false);

const newRule = computed(() => ({
	_id: '',
	category: '',
	autoApproveThreshold: 0.7,
	maxDailyAutoActions: 50,
	isEnabled: true,
}));

const availableCategories = [
	'support',
	'sales',
	'billing',
	'feature_request',
	'complaint',
	'spam',
	'internal',
	'other',
];

const hasAvailableCategories = computed(() => {
	return availableCategories.some((c) => !existingCategories.value.has(c));
});

// Toast notifications (global)
const { showToast: displayToast } = useToast();

const handleRuleSaved = () => {
	isAddingNew.value = false;
	displayToast('Autonomy rule saved successfully');
};

const handleRuleDeleted = () => {
	displayToast('Autonomy rule deleted');
};

const handleNewCancelled = () => {
	isAddingNew.value = false;
};

const handleKillSwitch = async () => {
	killSwitchBusy.value = true;
	try {
		const result = await runKillSwitch({});
		if (result === undefined) return;
		displayToast('Auto-sending stopped — reverted to draft-only');
	} finally {
		killSwitchBusy.value = false;
	}
};

const handleAcceptOffer = async (payload: { category: string; sender: string }) => {
	nudgePendingKey.value = `${payload.category}::${payload.sender}`;
	try {
		const result = await runSetSenderAutonomy({
			category: payload.category,
			sender: payload.sender,
			isEnabled: true,
		});
		if (result === undefined) return;
		displayToast(`Auto-send enabled for ${payload.sender}`);
	} finally {
		nudgePendingKey.value = null;
	}
};

const handleAcceptSuggestion = async (payload: { suggestionId: string }) => {
	nudgePendingKey.value = payload.suggestionId;
	try {
		const result = await runAcceptSuggestion({
			suggestionId: payload.suggestionId as Id<'autonomySuggestions'>,
		});
		if (result === undefined) return;
		displayToast('Graduation suggestion applied');
	} finally {
		nudgePendingKey.value = null;
	}
};

const handleAcknowledgeDemotion = async (payload: { ruleId: string }) => {
	demotionPendingId.value = payload.ruleId;
	try {
		const result = await runAcknowledgeDemotion({
			ruleId: payload.ruleId as Id<'autonomyRules'>,
		});
		if (result === undefined) return;
		displayToast('Alert dismissed');
	} finally {
		demotionPendingId.value = null;
	}
};

const handleSaveWorkingHours = async (payload: {
	enabled: boolean;
	timezone: string;
	start: number;
	end: number;
	days: number[];
}) => {
	workingHoursBusy.value = true;
	try {
		const result = await runUpdateConfig({
			isWorkingHoursEnabled: payload.enabled,
			workingHoursTimezone: payload.timezone,
			workingHoursStart: payload.start,
			workingHoursEnd: payload.end,
			workingHoursDays: payload.days,
		});
		if (result === undefined) return;
		displayToast('Working hours saved');
	} finally {
		workingHoursBusy.value = false;
	}
};
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
				<UiIconBox icon="lucide:sliders-horizontal" size="xl" variant="brand" rounded="full" />
				<div>
					<h1 class="text-2xl font-semibold text-text-primary">Graduated Autonomy</h1>
					<p class="text-text-secondary mt-1 max-w-xl">
						Configure per-category rules that control when the AI agent can auto-approve actions and
						when human review is required. Thresholds automatically adjust based on human feedback
						patterns.
					</p>
				</div>
			</div>
			<button
				v-if="hasAvailableCategories"
				class="btn btn-primary gap-2"
				:disabled="isAddingNew"
				@click="isAddingNew = true"
			>
				<Icon name="lucide:plus" class="w-4 h-4" />
				Add Rule
			</button>
		</div>

		<!-- Loading State -->
		<div v-if="rulesLoading" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">Loading autonomy rules...</p>
			</div>
		</div>

		<UiErrorAlert
			v-else-if="rulesError"
			title="Couldn't load autonomy rules"
			message="We hit an error loading autonomy rules. Reload to try again."
			class="my-8"
		/>

		<template v-else>
			<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
				<!-- Main content: rules list -->
				<div class="lg:col-span-2 space-y-4">
					<!-- Auto-demotion incident alerts (bad-outcome → draft-only) -->
					<AutonomyDemotionAlerts
						:incidents="demotions ?? []"
						:pending-id="demotionPendingId"
						@acknowledge="handleAcknowledgeDemotion"
					/>

					<!-- Graduation nudge: earned autonomy, accepted explicitly -->
					<AutonomyGraduationNudge
						:offers="scorecard ?? []"
						:suggestions="suggestions ?? []"
						:pending-key="nudgePendingKey"
						@accept-offer="handleAcceptOffer"
						@accept-suggestion="handleAcceptSuggestion"
					/>

					<!-- New Rule Form -->
					<AutonomyRuleEditor
						v-if="isAddingNew"
						:rule="newRule"
						:is-new="true"
						@saved="handleRuleSaved"
						@cancelled="handleNewCancelled"
					/>

					<!-- Existing Rules -->
					<AutonomyRuleEditor
						v-for="rule in rules"
						:key="rule._id"
						:rule="rule"
						@saved="handleRuleSaved"
						@deleted="handleRuleDeleted"
					/>

					<!-- Empty State -->
					<UiCard v-if="!rules?.length && !isAddingNew">
						<div class="py-8 text-center">
							<UiIconBox
								icon="lucide:sliders-horizontal"
								size="lg"
								variant="surface"
								class="mx-auto mb-4"
							/>
							<h3 class="text-base font-medium text-text-primary mb-2">
								No autonomy rules configured
							</h3>
							<p class="text-sm text-text-tertiary mb-4 max-w-sm mx-auto">
								Create rules to control how the AI agent handles different types of messages. Each
								category can have its own confidence threshold and daily limits.
							</p>
							<button class="btn btn-primary gap-2" @click="isAddingNew = true">
								<Icon name="lucide:plus" class="w-4 h-4" />
								Create First Rule
							</button>
						</div>
					</UiCard>
				</div>

				<!-- Sidebar: Kill switch + working hours + dials + stats -->
				<div class="space-y-4">
					<!-- One-click kill switch: stop auto-sending NOW -->
					<AutonomyKillSwitch :busy="killSwitchBusy" @confirm="handleKillSwitch" />

					<!-- Timezone-aware working-hours window -->
					<AutonomyWorkingHours
						:enabled="agentConfig?.isWorkingHoursEnabled ?? false"
						:timezone="agentConfig?.workingHoursTimezone ?? ''"
						:start="agentConfig?.workingHoursStart ?? 540"
						:end="agentConfig?.workingHoursEnd ?? 1020"
						:days="agentConfig?.workingHoursDays ?? [1, 2, 3, 4, 5]"
						:busy="workingHoursBusy"
						@save="handleSaveWorkingHours"
					/>

					<AutonomyAskEagernessDial />

					<AutonomyFeedbackStatsCard :stats="feedbackStats ?? null" />

					<!-- How It Works -->
					<UiCard>
						<div class="flex items-center gap-3 mb-4">
							<UiIconBox icon="lucide:info" size="sm" variant="surface" />
							<h3 class="text-base font-medium text-text-primary">How It Works</h3>
						</div>
						<div class="space-y-3 text-sm text-text-secondary">
							<div class="flex gap-3">
								<span
									class="shrink-0 w-5 h-5 rounded-full bg-brand-subtle text-brand text-xs font-semibold flex items-center justify-center"
									>1</span
								>
								<p>The agent classifies each inbound message into a category.</p>
							</div>
							<div class="flex gap-3">
								<span
									class="shrink-0 w-5 h-5 rounded-full bg-brand-subtle text-brand text-xs font-semibold flex items-center justify-center"
									>2</span
								>
								<p>
									If confidence exceeds the threshold and daily limit is not reached, the action is
									auto-approved.
								</p>
							</div>
							<div class="flex gap-3">
								<span
									class="shrink-0 w-5 h-5 rounded-full bg-brand-subtle text-brand text-xs font-semibold flex items-center justify-center"
									>3</span
								>
								<p>Otherwise, the action goes to the review queue for human approval.</p>
							</div>
							<div class="flex gap-3">
								<span
									class="shrink-0 w-5 h-5 rounded-full bg-brand-subtle text-brand text-xs font-semibold flex items-center justify-center"
									>4</span
								>
								<p>
									Thresholds auto-adjust weekly based on rejection patterns. High rejections tighten
									the threshold; low rejections loosen it.
								</p>
							</div>
						</div>
					</UiCard>
				</div>
			</div>

			<UiCard class="mt-6">
				<AutonomyHandlingRulesManager />
			</UiCard>
		</template>
	</div>
</template>
