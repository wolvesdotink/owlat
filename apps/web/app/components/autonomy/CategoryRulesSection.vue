<script setup lang="ts">
/**
 * The per-category rules on the AI replies page: which types of message the AI
 * may answer on its own, the graduation and demotion notices that go with
 * them, and the plain-words handling rules. The page mounts it only while the
 * agent and the `ai.autonomy` flag are both on; every query here asserts that
 * flag server-side, so none of them runs while it is off.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { AiReplyMode } from '~/utils/aiReplyMode';

defineProps<{
	/** The page's current mode; the heading copy differs between auto and draft. */
	mode: AiReplyMode;
}>();

const { t } = useI18n();
const { showToast } = useToast();

const {
	data: rules,
	isLoading: rulesLoading,
	error: rulesError,
} = useConvexQuery(api.autonomy.listRules, () => ({}));
const { data: scorecard } = useConvexQuery(
	api.agent.shadowScorecard.getShadowScorecard,
	() => ({})
);
const { data: suggestions } = useConvexQuery(
	api.autonomySuggestions.listGraduationSuggestions,
	() => ({})
);
const { data: demotions } = useConvexQuery(api.autonomyOutcome.listAutoDemotions, () => ({}));

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
	<section
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
</template>
