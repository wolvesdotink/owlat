<script setup lang="ts">
/**
 * "Two things before I write this" (plan §05): the questions "Draft with AI"
 * asks when the draft would otherwise have to guess.
 *
 * Built on the clarification question list both background loops use
 * (`ClarificationQuestions`: the reader's language, the remembered answer
 * pre-picked with its "last time" tag, the attribution line under each
 * question). What this card adds is one input per answer kind:
 *
 *  - choice: chips (keys 1 to 9 pick on the first open question) plus
 *    "Something else..." as free text;
 *  - text and number: a free-text line;
 *  - date: the suggested days as chips plus a date picker;
 *  - file: `FileAsk` (upload, a found candidate, Files, or "It isn't ready yet").
 *
 * "Answer and draft" sends what was answered; "Skip, draft with gaps" is always
 * there and sends the same, telling the server to stop asking: whatever is left
 * becomes a highlighted gap in the draft. A remembered answer left as it was
 * is not sent again (the server already holds it as remembered).
 */
import type { Id } from '@owlat/api/dataModel';
import { MAX_ASK_ROUNDS } from '@owlat/shared/answerMode';
import ClarificationQuestions from '~/components/agent-tasks/ClarificationQuestions.vue';
import TaskOptions from '~/components/agent-tasks/TaskOptions.vue';
import type { AskAnswer, AskQuestion } from '~/composables/useAnswerAskSession';
import {
	collectClarificationAnswers,
	type ClarificationAnswer,
} from '~/utils/clarificationAnswers';
import { localizedQuestionCopy } from '~/utils/clarificationLocale';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import { isDialogOpen } from '~/utils/dialogOpen';
import type { ThreadFile } from '~/utils/answerThreadFiles';
import FileAsk, { type FileAnswerRef, type FileAskValue } from './FileAsk.vue';

const props = withDefaults(
	defineProps<{
		questions: readonly AskQuestion[];
		/** The ask round; omitted for a background clarification, which has one. */
		round?: number;
		submitting?: boolean;
		mailboxId?: Id<'mailboxes'>;
		resolveThreadFile?: (file: ThreadFile) => Promise<FileAnswerRef | null>;
		/**
		 * The second button's words. "Skip, draft with gaps" for Draft with AI; a
		 * background clarification (the queue, the team agent) puts the card away
		 * instead ("Answer later").
		 */
		skipLabel?: string;
		/**
		 * Every question must be answered before "Answer and draft". The team
		 * agent's questions (its resumed draft can go out on its own, so a
		 * question left open would reach it as a guess); see ClarificationQuestions.
		 */
		requireAll?: boolean;
	}>(),
	{
		requireAll: false,
		round: undefined,
		submitting: false,
		mailboxId: undefined,
		resolveThreadFile: undefined,
		skipLabel: undefined,
	}
);

const emit = defineEmits<{
	answer: [answers: AskAnswer[]];
	skip: [answers: AskAnswer[]];
}>();

const { t, locale } = useI18n();

type Kind = NonNullable<AskQuestion['answerKind']>;
function kindOf(question: AskQuestion): Kind {
	return question.answerKind ?? ((question.options?.length ?? 0) > 0 ? 'choice' : 'text');
}
/** The list hands its slot the shared question shape; this card needs its own. */
const byId = computed(() => new Map(props.questions.map((q) => [q.id, q])));
const askOf = (id: string): AskQuestion => byId.value.get(id)!;

const listRef = ref<InstanceType<typeof ClarificationQuestions> | null>(null);
/** What this card set per question (the list holds the same values). */
const values = reactive<Record<string, string>>({});
const fileValues = reactive<Record<string, FileAskValue>>({});

function set(questionId: string, value: string, setValue: (v: string) => void) {
	values[questionId] = value;
	setValue(value);
}

function onFileValue(questionId: string, value: FileAskValue, setValue: (v: string) => void) {
	fileValues[questionId] = value;
	const label = !value ? '' : value.kind === 'file' ? value.file.filename : value.value;
	set(questionId, label, setValue);
}

/** Submitted answers as the server takes them. */
function toAskAnswers(answers: readonly ClarificationAnswer[]): AskAnswer[] {
	return answers.flatMap((answer): AskAnswer[] => {
		if (answer.source === 'memory') return [];
		const file = fileValues[answer.questionId];
		if (file?.kind === 'file') {
			return [{ questionId: answer.questionId, file: file.file, keepCopy: file.keepCopy }];
		}
		return [{ questionId: answer.questionId, value: answer.value }];
	});
}

function onSubmit(answers: ClarificationAnswer[]) {
	emit('answer', toAskAnswers(answers));
}

function skip() {
	if (props.submitting) return;
	emit('skip', toAskAnswers(collectClarificationAnswers(props.questions, values, locale.value)));
}

// Keys 1 to 9: a chip of the first open question that has chips.
function onKeydown(event: KeyboardEvent) {
	if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
	if (!/^[1-9]$/.test(event.key) || props.submitting) return;
	if (isEditableTarget(event.target) || isDialogOpen()) return;
	const withChips = props.questions.filter(
		(q) => kindOf(q) !== 'file' && (q.options?.length ?? 0) > 0
	);
	// A remembered answer counts as answered until the person clears it.
	const question =
		withChips.find((q) => !(values[q.id] ?? q.answer?.value ?? '').trim()) ?? withChips[0];
	if (!question) return;
	const copy = localizedQuestionCopy(question, locale.value);
	const option = copy.options[Number(event.key) - 1];
	if (option === undefined) return;
	event.preventDefault();
	values[question.id] = option;
	listRef.value?.setValue(question.id, option);
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

const titleId = useId();
</script>

<template>
	<section
		class="border-b border-border-subtle bg-bg-base/40 px-3 py-3"
		:aria-labelledby="titleId"
		:aria-busy="submitting"
		data-testid="ask-card"
	>
		<ClarificationQuestions
			ref="listRef"
			:questions="questions"
			:require-all="requireAll"
			:submitting="submitting"
			test-id-prefix="ask"
			@submit="onSubmit"
		>
			<template #header>
				<div class="flex flex-wrap items-baseline gap-x-2">
					<Icon name="lucide:sparkles" class="size-3.5 self-center text-brand" aria-hidden="true" />
					<h2 :id="titleId" class="text-sm font-semibold text-text-primary">
						{{
							t('components.answer.askCard.title', { count: questions.length }, questions.length)
						}}
					</h2>
					<span
						v-if="round !== undefined"
						class="text-xs text-text-tertiary"
						data-testid="ask-round"
					>
						{{ t('components.answer.askCard.round', { round, total: MAX_ASK_ROUNDS }) }}
					</span>
				</div>
				<p class="mt-0.5 text-xs text-text-secondary">
					{{ t('components.answer.askCard.subline') }}
				</p>
			</template>

			<template #answer="{ question, copy, remembered, value, setValue }">
				<FileAsk
					v-if="kindOf(askOf(question.id)) === 'file'"
					:question="askOf(question.id)"
					:options="copy.options"
					:model-value="fileValues[question.id] ?? null"
					:mailbox-id="mailboxId"
					:resolve-thread-file="resolveThreadFile"
					:disabled="submitting"
					@update:model-value="onFileValue(question.id, $event, setValue)"
				/>
				<template v-else>
					<TaskOptions
						class="mt-1.5"
						:model-value="value"
						:options="copy.options"
						:remembered="remembered"
						:disabled="submitting"
						:placeholder="t(`components.answer.askCard.placeholder.${kindOf(askOf(question.id))}`)"
						chip-test-id="ask-chip"
						input-test-id="ask-input"
						@update:model-value="set(question.id, $event, setValue)"
					/>
					<label
						v-if="kindOf(askOf(question.id)) === 'date'"
						class="mt-1.5 flex items-center gap-2 text-xs text-text-secondary"
					>
						{{ t('components.answer.askCard.pickDate') }}
						<input
							type="date"
							class="input input-sm w-auto"
							:disabled="submitting"
							data-testid="ask-date"
							@change="set(question.id, ($event.target as HTMLInputElement).value, setValue)"
						/>
					</label>
				</template>
			</template>

			<template #actions="{ canSubmit, submit }">
				<div class="mt-3 flex flex-wrap items-center gap-2">
					<UiButton
						type="button"
						size="sm"
						:disabled="!canSubmit"
						data-testid="ask-submit"
						@click="submit"
					>
						<Icon
							v-if="submitting"
							name="lucide:loader-2"
							class="mr-1 size-3.5 animate-spin motion-reduce:animate-none"
							aria-hidden="true"
						/>
						{{ t('components.answer.askCard.answerAndDraft') }}
					</UiButton>
					<UiButton
						type="button"
						size="sm"
						variant="ghost"
						:disabled="submitting"
						data-testid="ask-skip"
						@click="skip"
					>
						{{ skipLabel ?? t('components.answer.askCard.skip') }}
					</UiButton>
				</div>
			</template>
		</ClarificationQuestions>
	</section>
</template>
