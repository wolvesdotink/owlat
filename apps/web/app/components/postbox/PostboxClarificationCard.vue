<script setup lang="ts">
import ClarificationQuestions from '~/components/agent-tasks/ClarificationQuestions.vue';
import TaskActions from '~/components/agent-tasks/TaskActions.vue';
import TaskAsk from '~/components/agent-tasks/TaskAsk.vue';
import TaskCardShell from '~/components/agent-tasks/TaskCardShell.vue';
import TaskContext from '~/components/agent-tasks/TaskContext.vue';
import { resolveAgentTaskShortcut } from '~/utils/agentTaskShortcuts';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import type { ReplyQueueItem } from '~/utils/postboxReplyQueue';
import { clarificationCardState } from '~/utils/postboxReplyQueue';
import type { ClarificationAnswer } from '~/utils/clarificationAnswers';

/**
 * "Needs your input" Reply Queue card — the Postbox-native clarification loop,
 * built on the shared agent-task card anatomy (TaskCardShell/Context/Ask/
 * Options/Actions) so it renders identically to its Review Queue siblings.
 *
 * When the AI decided a good reply is missing a fact only the owner can supply,
 * the thread carries `clarification.questions`. Each question renders with its
 * sender attribution (the WHY line), single-select option chips and a free-text
 * box (the shared ClarificationQuestions list, where one answer is enough), so
 * the owner can resolve it without opening the thread. Answering flips
 * the card: 'asking' → 'drafting' (starter reply generating) → 'ready' ("Draft
 * ready", open the composer prefilled).
 *
 * Keyboard (card-scoped, inert while typing): 1–9 picks a chip on the first
 * open question, Enter submits / opens the draft, s defers ("I'll answer
 * later" — non-destructive, the row returns to the plain queue), Esc drops
 * focus back to the list.
 *
 * Stateless w.r.t. the server: it emits `answer` with the collected values and
 * the parent drives the mutation + live subscription; the card re-renders as
 * the persisted `clarification` prop advances through the states above.
 * `defer` is the non-destructive escape (vs the destructive `done`).
 */
const props = defineProps<{ item: ReplyQueueItem; submitting?: boolean }>();
const emit = defineEmits<{
	(e: 'answer', answers: ClarificationAnswer[]): void;
	(e: 'open-draft', draft: string): void;
	(e: 'open'): void;
	(e: 'done'): void;
	(e: 'defer'): void;
}>();

const { t } = useI18n();

const clarification = computed(() => props.item.clarification);
const state = computed(() => clarificationCardState(clarification.value));
const questions = computed(() => clarification.value?.questions ?? []);
const questionList = ref<InstanceType<typeof ClarificationQuestions> | null>(null);

// A question answer-memory filled starts on the remembered value with its
// "last time" tag (ClarificationQuestions); each answer says whether it went
// back untouched (`memory`), so the mutation does not capture a replayed fact
// again as the owner's own.
function onAnswers(answers: ClarificationAnswer[]) {
	emit('answer', answers);
}

/**
 * Card-scoped keyboard (never a window handler — it composes with the queue's
 * listbox handling by stopping propagation only for keys it consumes). Inert
 * while the free-text input has focus, so typing stays typing.
 */
function onCardKeydown(event: KeyboardEvent) {
	if (event.metaKey || event.ctrlKey || event.altKey) return;
	if (isEditableTarget(event.target)) return;
	const shortcut = resolveAgentTaskShortcut(event.key);
	if (!shortcut) return;
	switch (shortcut.type) {
		case 'chip':
			if (state.value !== 'asking') return;
			questionList.value?.pickIndex(shortcut.index);
			break;
		case 'submit':
			if (state.value === 'asking') questionList.value?.submit();
			else if (state.value === 'ready') emit('open-draft', clarification.value?.draft ?? '');
			else return;
			break;
		case 'skip':
			emit('defer');
			break;
		case 'exit':
			(event.currentTarget as HTMLElement | null)?.blur();
			break;
		default:
			return;
	}
	event.preventDefault();
	event.stopPropagation();
}
</script>

<template>
	<TaskCardShell
		data-testid="clarification-card"
		tabindex="0"
		:aria-label="
			t('components.postbox.postboxClarificationCard.cardLabel', { subject: item.subject })
		"
		@keydown="onCardKeydown"
	>
		<TaskContext
			:who="item.fromName || item.fromAddress"
			:name="item.fromName"
			:email="item.fromAddress"
			:status="{
				label:
					state === 'ready'
						? t('components.postbox.postboxClarificationCard.statusDraftReady')
						: t('components.postbox.postboxClarificationCard.statusNeedsInput'),
				icon: 'lucide:message-circle-question',
				tone: 'brand',
			}"
		/>

		<!-- asking: question(s) + chips + free text -->
		<template v-if="state === 'asking'">
			<ClarificationQuestions
				ref="questionList"
				:questions="questions"
				:require-all="false"
				:submitting="submitting"
				@submit="onAnswers"
			>
				<template #actions="{ canSubmit, submit }">
					<TaskActions
						class="mt-2"
						:primary-label="t('components.postbox.postboxClarificationCard.answer')"
						primary-test-id="clarification-submit"
						:primary-disabled="!canSubmit"
						:primary-loading="submitting"
						:skip-label="t('common.dismiss')"
						skip-test-id="clarification-dismiss"
						:hints="[
							{ keys: ['1–9'], label: t('components.postbox.postboxClarificationCard.hintPick') },
							{ keys: ['Enter'], label: t('components.postbox.postboxClarificationCard.answer') },
							{ keys: ['s'], label: t('components.postbox.postboxClarificationCard.hintLater') },
						]"
						@primary="submit"
						@skip="emit('done')"
					/>
				</template>
			</ClarificationQuestions>
		</template>

		<!-- drafting: answered, starter reply generating. "I'll answer later" is
			the NON-DESTRUCTIVE escape — it returns the item to the plain queue
			(the clarification survives server-side) instead of clearing it; a
			failed/slow draft (AI gate off, empty output, staleness-skipped
			persist) never strands the card. Dismiss stays for actually clearing. -->
		<div v-else-if="state === 'drafting'" class="mt-2" data-testid="clarification-drafting">
			<div class="flex items-center gap-2 text-sm text-text-secondary">
				<Icon name="lucide:loader-2" class="w-4 h-4 animate-spin motion-reduce:animate-none" />
				{{ t('components.postbox.postboxClarificationCard.drafting') }}
			</div>
			<div class="flex items-center gap-2 mt-2">
				<button
					type="button"
					data-testid="clarification-drafting-defer"
					class="text-xs font-medium px-2.5 py-1.5 rounded border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors duration-(--motion-fast)"
					@click.stop="emit('defer')"
				>
					{{ t('components.postbox.postboxClarificationCard.answerLater') }}
				</button>
				<button
					type="button"
					data-testid="clarification-drafting-dismiss"
					class="text-xs px-2 py-1.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors duration-(--motion-fast)"
					@click.stop="emit('done')"
				>
					{{ t('common.dismiss') }}
				</button>
			</div>
		</div>

		<!-- ready: starter reply available -->
		<template v-else-if="state === 'ready'">
			<TaskAsk class="mt-2" :detail="clarification?.draft" />
			<TaskActions
				class="mt-2"
				:primary-label="t('components.postbox.postboxClarificationCard.openDraft')"
				primary-test-id="clarification-open-draft"
				:skip-label="t('common.done')"
				skip-test-id="clarification-done"
				:hints="[
					{
						keys: ['Enter'],
						label: t('components.postbox.postboxClarificationCard.openDraft'),
					},
				]"
				@primary="emit('open-draft', clarification?.draft ?? '')"
				@skip="emit('done')"
			/>
		</template>
	</TaskCardShell>
</template>
