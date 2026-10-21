<script setup lang="ts">
/**
 * The hosted-decision opt-out of one mailbox, or of the Team Inbox: mail that must never reach a decision provider outside the operator's
 * own hardware. Excluded mail is judged only by the local decision engine;
 * without one it gets no decision requests at all, which is how it worked
 * before the decision plane. Admin only (the server checks again, and audits
 * it); a member sees the state and who can change it.
 *
 * Shown where that inbox's AI settings live: the Team Inbox on AI replies,
 * each mailbox on Writing voice.
 */
import { api } from '@owlat/api';
import type { FunctionArgs } from 'convex/server';

type ExclusionTarget = FunctionArgs<
	typeof api.decision.exclusion.setHostedDecisionExclusion
>['target'];

const props = defineProps<{
	target: ExclusionTarget;
	/** The stored state (`isExcludedFromHostedDecisions`, absent ⇒ false). */
	isExcluded: boolean;
	/** The mailbox's address, named in its help line. */
	address?: string;
}>();

const { t } = useI18n();
const K = 'components.settings.hostedDecisionExclusion';
const { isAdmin } = usePermissions();

const setExclusion = useBackendOperation(api.decision.exclusion.setHostedDecisionExclusion, {
	label: () => t(`${K}.operation`),
});

const help = computed(() =>
	props.target.kind === 'team_inbox'
		? t(`${K}.helpTeamInbox`)
		: t(`${K}.helpMailbox`, { address: props.address ?? '' })
);

function toggle(isExcluded: boolean) {
	if (!isAdmin.value || isExcluded === props.isExcluded) return;
	void setExclusion.run({ target: props.target, isExcluded });
}
</script>

<template>
	<div
		class="flex items-start justify-between gap-4 rounded-lg border border-border-subtle p-3"
		:data-testid="`hosted-decision-exclusion-${target.kind}`"
	>
		<div class="min-w-0 text-sm">
			<p class="font-medium text-text-primary">{{ t(`${K}.label`) }}</p>
			<p class="mt-0.5 text-text-secondary">{{ help }}</p>
			<p v-if="!isAdmin" class="mt-1 text-xs text-text-tertiary">{{ t(`${K}.adminOnly`) }}</p>
		</div>
		<UiSwitch
			:model-value="isExcluded"
			:label="t(`${K}.label`)"
			:disabled="!isAdmin || setExclusion.isLoading.value"
			@update:model-value="toggle"
		/>
	</div>
</template>
