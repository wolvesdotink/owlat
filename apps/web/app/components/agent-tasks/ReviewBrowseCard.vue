<script setup lang="ts">
import TaskActions from '~/components/agent-tasks/TaskActions.vue';
import TaskAsk from '~/components/agent-tasks/TaskAsk.vue';
import TaskContext from '~/components/agent-tasks/TaskContext.vue';
import type { ReviewRow } from '~/utils/reviewRow';
import { escalationTrustLabel, trustLabel, type TrustLabel } from '~/utils/trustLabel';

/**
 * ONE Review Queue card: the shared task-card anatomy (who/when + trust chip,
 * the ask, then either an inline compose box for a draftless escalation or the
 * agent's draft with its approve/reject actions). Split out of
 * ReviewBrowseList.vue, which keeps the listbox, its keyboard model and the
 * optimistic-hide wiring — every action here is emitted, never sent from the
 * card, so both the buttons and the j/k/a/e/x keys go through the same handlers.
 */
const props = defineProps<{
	row: ReviewRow;
	/** A draftless complaint/urgent escalation — the admin composes the reply. */
	needsReply: boolean;
	aiEnabled: boolean;
	/** An action for this row is in flight. */
	busy: boolean;
}>();

const emit = defineEmits<{
	/** A freeform whole-draft revision to persist onto the card's draft. */
	reviseApply: [text: string];
	attach: [candidate: { fileId: string; filename: string }];
	approve: [];
	reject: [];
	composeSend: [];
}>();

/** The picked draft option on multi-option cards (absent ⇒ the primary draft). */
const selectedOption = defineModel<number | undefined>('selectedOption');
const composeSubject = defineModel<string | undefined>('composeSubject');
const composeBody = defineModel<string | undefined>('composeBody');

const { t } = useI18n();

// Human trust chip replacing the raw confidence % badge. Draft cards map the
// DRAFT self-check (score + flags → plain-language reasons); draftless
// escalations always read "Needs you". The old numbers stay reachable as the
// chip popover's quiet footer (trustDetail) — disclosure, not deletion.
const trust = computed<TrustLabel>(() => {
	const message = props.row.message;
	if (props.needsReply) return escalationTrustLabel();
	return trustLabel(
		message.draftQuality ? message.draftQuality.score : null,
		message.draftQuality?.flags ?? []
	);
});

/** Quiet footer line keeping the classifier's certainty available to power users. */
const trustDetail = computed<string | undefined>(() => {
	const confidence = props.row.message.classification?.confidence;
	return typeof confidence === 'number'
		? t('components.agentTasks.reviewBrowseList.classifierConfidence', {
				percent: Math.round(confidence * 100),
			})
		: undefined;
});

/**
 * The muted one-line WHY under the card's ask (shared task-card anatomy):
 * the route step's recorded reason for holding/escalating, moved up from the
 * old rationale block. Grounding provenance stays in InboxDecisionRationale.
 */
const why = computed<string | undefined>(() => {
	const reason = props.row.message.agentDecision?.reason;
	if (!reason) return undefined;
	return props.needsReply
		? t('components.agentTasks.reviewBrowseList.escalatedBecause', { reason })
		: t('components.agentTasks.reviewBrowseList.heldBecause', { reason });
});
</script>

<template>
	<TaskContext :who="row.message.from" icon="lucide:mail">
		<template #meta>
			{{ formatCompactRelativeTime(row.message._creationTime) }}
			<template v-if="row.thread">
				&middot;
				<NuxtLink :to="`/dashboard/inbox/${row.thread._id}`" class="text-brand hover:underline">
					{{ t('components.agentTasks.reviewBrowseList.viewThread') }}
				</NuxtLink>
			</template>
		</template>
		<!-- One roll-up trust chip (human language; reasons + raw numbers in its popover) + category chip. -->
		<template #trailing>
			<div v-if="row.message.classification" class="flex items-center gap-2">
				<InboxTrustChip :trust="trust" :extra-detail="trustDetail" />
				<span class="text-xs px-2 py-0.5 rounded-full bg-brand-subtle text-brand">
					{{ row.message.classification.category }}
				</span>
			</div>
		</template>
	</TaskContext>

	<!-- The ask: subject + excerpt, with the muted one-line WHY the agent held/escalated it. -->
	<TaskAsk
		class="mt-3 mb-4"
		:ask="row.message.subject || undefined"
		:detail="row.message.textBody || t('components.agentTasks.reviewBrowseList.noTextContent')"
		:why="why"
	/>

	<!-- Draftless escalation: compose a reply inline -->
	<template v-if="needsReply">
		<div class="bg-warning/5 border border-warning/20 rounded-lg p-4 mb-4">
			<div class="flex items-center gap-2 mb-3">
				<Icon name="lucide:user-round" class="w-4 h-4 text-warning" />
				<p class="text-xs font-medium text-warning uppercase tracking-wider">
					{{ t('components.agentTasks.reviewBrowseList.escalatedHeading') }}
				</p>
			</div>
			<input
				v-model="composeSubject"
				type="text"
				class="input w-full text-sm mb-3"
				:placeholder="t('components.agentTasks.reviewBrowseList.subjectPlaceholder')"
			/>
			<textarea
				v-model="composeBody"
				rows="6"
				class="input w-full text-sm resize-y"
				:placeholder="t('components.agentTasks.reviewBrowseList.replyPlaceholder')"
			/>
			<!-- Coach the ADMIN's own reply before they send it. Advisory only — never rewrites the text. -->
			<PostboxCoachPanel
				:draft-text="composeBody ?? ''"
				:enabled="aiEnabled"
				:thread-context="row.message.textBody ?? undefined"
			/>
		</div>

		<!-- What the agent had to work from (WHY line above carries the escalation reason). -->
		<InboxDecisionRationale :grounding-sources="row.message.groundingSources" class="mb-4" />

		<!-- Actions -->
		<TaskActions
			:primary-label="t('components.agentTasks.reviewBrowseList.sendReply')"
			primary-icon="lucide:send"
			:primary-disabled="busy || !composeBody?.trim()"
			:skip-label="t('common.dismiss')"
			skip-destructive
			:skip-disabled="busy"
			@primary="emit('composeSend')"
			@skip="emit('reject')"
		>
			<NuxtLink
				v-if="row.thread"
				:to="`/dashboard/inbox/${row.thread._id}`"
				class="inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors duration-(--motion-fast)"
			>
				<Icon name="lucide:external-link" class="w-3 h-3" />
				{{ t('components.agentTasks.reviewBrowseList.openThread') }}
			</NuxtLink>
		</TaskActions>
	</template>

	<!-- Agent draft awaiting approval -->
	<template v-else>
		<!-- Multiple pickable draft options (low-confidence / low-quality cases) -->
		<InboxDraftOptions
			v-if="(row.message.draftOptions?.length ?? 0) > 1"
			:options="row.message.draftOptions ?? []"
			:model-value="selectedOption ?? 0"
			class="mb-4"
			@update:model-value="selectedOption = $event"
		/>

		<!-- Single agent draft -->
		<div v-else class="bg-brand-subtle/30 rounded-lg p-4 mb-4">
			<div class="flex items-center gap-2 mb-2">
				<Icon name="lucide:bot" class="w-4 h-4 text-brand" />
				<p class="text-xs font-medium text-brand uppercase tracking-wider">
					{{ t('components.agentTasks.reviewBrowseList.agentDraft') }}
				</p>
			</div>
			<p class="text-text-primary text-sm whitespace-pre-wrap">
				{{ row.message.draftResponse }}
			</p>

			<!-- Freeform whole-draft revise ("redo but decline politely"), streamed. -->
			<AiReviseBox
				v-if="aiEnabled && row.message.draftResponse"
				class="mt-3"
				surface="review"
				:ai-enabled="aiEnabled"
				:current-draft="row.message.draftResponse ?? ''"
				@apply="(text: string) => emit('reviseApply', text)"
			/>
		</div>

		<!-- One-tap "attach the right file?" when a contact-scoped file matched the request. Advisory; the human confirms — the agent never auto-attaches. -->
		<InboxAttachSuggestion
			v-if="(row.message.attachmentSuggestions?.candidates?.length ?? 0) > 0"
			:suggestions="row.message.attachmentSuggestions!"
			class="mb-4"
			@attach="(c) => emit('attach', c)"
		/>

		<!-- What it was grounded in (WHY line above carries the hold reason; read-only). -->
		<InboxDecisionRationale :grounding-sources="row.message.groundingSources" class="mb-4" />

		<!-- Actions -->
		<TaskActions
			:primary-label="t('components.agentTasks.reviewBrowseList.approveAndSend')"
			primary-icon="lucide:check"
			:primary-disabled="busy"
			:skip-label="t('components.agentTasks.reviewBrowseList.reject')"
			skip-destructive
			:skip-disabled="busy"
			@primary="emit('approve')"
			@skip="emit('reject')"
		>
			<NuxtLink
				v-if="row.thread"
				:to="`/dashboard/inbox/${row.thread._id}`"
				class="inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors duration-(--motion-fast)"
			>
				<Icon name="lucide:pencil" class="w-3 h-3" />
				{{ t('common.edit') }}
			</NuxtLink>
		</TaskActions>
	</template>
</template>
