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
import SettingsResetToDefault from './ResetToDefault.vue';

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

// The explanation is the "why", one interaction away: on Connected mailboxes
// this control repeats under every mailbox, and the list is the page's task.
const showHelp = ref(false);

function toggle(isExcluded: boolean) {
	if (!isAdmin.value || isExcluded === props.isExcluded) return;
	void setExclusion.run({ target: props.target, isExcluded });
}
</script>

<template>
	<div
		class="rounded-lg border border-border-subtle p-3 text-sm"
		:data-testid="`hosted-decision-exclusion-${target.kind}`"
	>
		<div class="flex items-center justify-between gap-4">
			<div class="min-w-0 flex flex-wrap items-center gap-x-2 gap-y-1">
				<p class="font-medium text-text-primary">{{ t(`${K}.label`) }}</p>
				<!-- Not excluded is the default (absent ⇒ false). Admin only, like the switch. -->
				<SettingsResetToDefault
					:changed="isExcluded"
					:label="t(`${K}.label`)"
					:disabled="!isAdmin || setExclusion.isLoading.value"
					@reset="toggle(false)"
				/>
			</div>
			<UiSwitch
				:model-value="isExcluded"
				:label="t(`${K}.label`)"
				:disabled="!isAdmin || setExclusion.isLoading.value"
				@update:model-value="toggle"
			/>
		</div>
		<p v-if="!isAdmin" class="mt-1 text-xs text-text-tertiary">{{ t(`${K}.adminOnly`) }}</p>
		<UiDisclosure v-model="showHelp" :label="t('common.learnMore')" class="mt-1">
			<p class="text-text-secondary" data-testid="hosted-decision-exclusion-help">{{ help }}</p>
		</UiDisclosure>
	</div>
</template>
