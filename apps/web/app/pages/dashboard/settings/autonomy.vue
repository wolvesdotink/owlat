<script setup lang="ts">
import { api } from '@owlat/api';

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	// Mirror the nav gate: only reachable when ai.autonomy is enabled.
	requiresFeature: 'ai.autonomy',
});

useHead({ title: 'Autonomy Rules — Owlat' });

// Fetch existing rules
const { data: rules, isLoading: rulesLoading, error: rulesError } = useConvexQuery(
	api.autonomy.listRules,
	() => ({}),
);

// Fetch feedback stats for the last 24h
const { data: feedbackStats } = useConvexQuery(
	api.autonomy.getFeedbackStats,
	() => ({ hoursBack: 24 }),
);

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
	'support', 'sales', 'billing', 'feature_request',
	'complaint', 'spam', 'internal', 'other',
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
						Configure per-category rules that control when the AI agent can auto-approve actions
						and when human review is required. Thresholds automatically adjust based on human
						feedback patterns.
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
							<h3 class="text-base font-medium text-text-primary mb-2">No autonomy rules configured</h3>
							<p class="text-sm text-text-tertiary mb-4 max-w-sm mx-auto">
								Create rules to control how the AI agent handles different types of messages.
								Each category can have its own confidence threshold and daily limits.
							</p>
							<button
								class="btn btn-primary gap-2"
								@click="isAddingNew = true"
							>
								<Icon name="lucide:plus" class="w-4 h-4" />
								Create First Rule
							</button>
						</div>
					</UiCard>
				</div>

				<!-- Sidebar: Feedback Stats -->
				<div class="space-y-4">
					<AutonomyFeedbackStatsCard :stats="feedbackStats ?? null" />

					<!-- How It Works -->
					<UiCard>
						<div class="flex items-center gap-3 mb-4">
							<UiIconBox icon="lucide:info" size="sm" variant="surface" />
							<h3 class="text-base font-medium text-text-primary">How It Works</h3>
						</div>
						<div class="space-y-3 text-sm text-text-secondary">
							<div class="flex gap-3">
								<span class="shrink-0 w-5 h-5 rounded-full bg-brand-subtle text-brand text-xs font-semibold flex items-center justify-center">1</span>
								<p>The agent classifies each inbound message into a category.</p>
							</div>
							<div class="flex gap-3">
								<span class="shrink-0 w-5 h-5 rounded-full bg-brand-subtle text-brand text-xs font-semibold flex items-center justify-center">2</span>
								<p>If confidence exceeds the threshold and daily limit is not reached, the action is auto-approved.</p>
							</div>
							<div class="flex gap-3">
								<span class="shrink-0 w-5 h-5 rounded-full bg-brand-subtle text-brand text-xs font-semibold flex items-center justify-center">3</span>
								<p>Otherwise, the action goes to the review queue for human approval.</p>
							</div>
							<div class="flex gap-3">
								<span class="shrink-0 w-5 h-5 rounded-full bg-brand-subtle text-brand text-xs font-semibold flex items-center justify-center">4</span>
								<p>Thresholds auto-adjust weekly based on rejection patterns. High rejections tighten the threshold; low rejections loosen it.</p>
							</div>
						</div>
					</UiCard>
				</div>
			</div>
		</template>
	</div>
</template>
