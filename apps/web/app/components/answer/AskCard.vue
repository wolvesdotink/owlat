<script setup lang="ts">
/**
 * "Two things before I write this" (plan §05): the questions "Draft with AI"
 * asks when the draft would otherwise have to guess.
 *
 * Built on the clarification question list both background loops use
 * (`ClarificationQuestions`: the reader's language, the remembered answer
 * pre-picked with its "last time" tag). What this card adds is one input per
 * answer kind:
 *
 *  - choice: chips (keys 1 to 9 pick on the first open question) plus
 *    "Something else..." as free text;
 *  - text and number: a free-text line;
 *  - date: the suggested days as chips plus a date picker;
 *  - file: `FileAsk` (upload, a found candidate, Files, or "It isn't ready yet").
 *
 * No draft is written while the card is up: the reply is written once every
 * question has an answer ("Answer and draft", enabled only then), or when the
 * person chooses "Draft with what I have", which sends what was answered and
 * lets whatever is left become a highlighted gap in the draft. A remembered
 * answer left as it was is not sent again (the server already holds it as
 * remembered), and a question already answered is not shown again when the
 * card comes back with more (a gap the draft found).
 *
 * The Reply Queue's file questions take several files (`multipleFiles`).
 *
 * The card is the one thing the person has to do before the reply can go,
 * so it reads as a card, not as another strip of the composer. Where the
 * questions came from is said once, under them, in the reader's language
 * (`ClarificationTrustLine`).
 */
import type { Id } from '@owlat/api/dataModel';
import ClarificationQuestions from '~/components/agent-tasks/ClarificationQuestions.vue';
import ClarificationTrustLine from '~/components/agent-tasks/ClarificationTrustLine.vue';
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
import FileAsk, { type FileAnswerRef, type FileAskValue, type FileCopyPolicy } from './FileAsk.vue';

/** An answer as the card emits it: `files` only when `multipleFiles` is on. */
export type AskCardAnswer = AskAnswer & { files?: FileAnswerRef[] };

const props = withDefaults(
	defineProps<{
		questions: readonly AskQuestion[];
		submitting?: boolean;
		mailboxId?: Id<'mailboxes'>;
		resolveThreadFile?: (file: ThreadFile) => Promise<FileAnswerRef | null>;
		/**
		 * The team agent's questions. Its draft cannot be written with gaps yet, so
		 * the second button puts the card away ("I'll answer later") instead of
		 * drafting with what the person has, and the subline says so.
		 */
		teamAgent?: boolean;
		/** Whether an uploaded file answer is kept in Files (see FileAsk). */
		copyPolicy?: FileCopyPolicy;
		/** File questions take several files (the Reply Queue's answer does). */
		multipleFiles?: boolean;
		/** The AI budget refused the last answer; the answers stay to try again (U5). */
		budgetRefused?: boolean;
	}>(),
	{
		submitting: false,
		mailboxId: undefined,
		resolveThreadFile: undefined,
		teamAgent: false,
	}
);

const emit = defineEmits<{
	answer: [answers: AskCardAnswer[]];
	skip: [answers: AskCardAnswer[]];
}>();

const { t, locale } = useI18n();

type Kind = NonNullable<AskQuestion['answerKind']>;
function kindOf(question: AskQuestion): Kind {
	return question.answerKind ?? ((question.options?.length ?? 0) > 0 ? 'choice' : 'text');
}
/**
 * The questions still to answer: a remembered answer is shown to confirm, one
 * the person gave in an earlier round is not asked again (a blank one is).
 */
const shown = computed(() =>
	props.questions.filter((q) => {
		const answer = q.answer;
		if (!answer || answer.source === 'memory') return true;
		return !answer.value.trim() && !answer.file && !answer.files?.length;
	})
);
/** The list hands its slot the shared question shape; this card needs its own. */
const byId = computed(() => new Map(shown.value.map((q) => [q.id, q])));
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
	const label = !value
		? ''
		: value.kind === 'file'
			? value.file.filename
			: value.kind === 'files'
				? value.files.map((f) => f.filename).join(', ')
				: value.value;
	set(questionId, label, setValue);
}

/** Submitted answers as the server takes them. */
function toAskAnswers(answers: readonly ClarificationAnswer[]): AskCardAnswer[] {
	return answers.flatMap((answer): AskCardAnswer[] => {
		if (answer.source === 'memory') return [];
		const file = fileValues[answer.questionId];
		if (file?.kind === 'file') {
			return [{ questionId: answer.questionId, file: file.file, keepCopy: file.keepCopy }];
		}
		if (file?.kind === 'files') {
			return [{ questionId: answer.questionId, files: file.files, keepCopy: file.keepCopy }];
		}
		return [{ questionId: answer.questionId, value: answer.value }];
	});
}

function onSubmit(answers: ClarificationAnswer[]) {
	emit('answer', toAskAnswers(answers));
}

function skip() {
	if (props.submitting) return;
	emit('skip', toAskAnswers(collectClarificationAnswers(shown.value, values, locale.value)));
}

// Keys 1 to 9: a chip of the first open question that has chips. Not while
// the card is out of sight: on a phone the reply sheet stays mounted behind
// the Conversation tab (AnswerModeFrame marks it `data-sheet-hidden`), and a
// key must not pick a chip nobody can see.
const rootEl = ref<HTMLElement | null>(null);
function onKeydown(event: KeyboardEvent) {
	if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
	if (!/^[1-9]$/.test(event.key) || props.submitting) return;
	if (isEditableTarget(event.target) || isDialogOpen()) return;
	if (rootEl.value?.closest('[data-sheet-hidden]')) return;
	const withChips = shown.value.filter((q) => kindOf(q) !== 'file' && (q.options?.length ?? 0) > 0);
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

const FOCUSABLE =
	'input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), button:not(:disabled)';

/**
 * Put the focus where the answering starts: the first control of the first
 * question still open (a remembered answer counts as answered), or "Answer and
 * draft" once every question has one. Synchronous, so a tap that calls it
 * raises the phone's keyboard. False when there is nothing to focus.
 */
function focusFirstOpen(): boolean {
	const open = shown.value.findIndex((q) => !(values[q.id] ?? q.answer?.value ?? '').trim());
	const rows = rootEl.value?.querySelectorAll<HTMLElement>('[data-testid="ask-question"]');
	const target =
		open >= 0
			? rows?.[open]?.querySelector<HTMLElement>(FOCUSABLE)
			: rootEl.value?.querySelector<HTMLElement>('[data-testid="ask-submit"]:not(:disabled)');
	if (!target) return false;
	target.focus();
	return true;
}
defineExpose({ focusFirstOpen });

const titleId = useId();

const title = computed(() => {
	const count = shown.value.length;
	return t('components.answer.askCard.title', { count }, count);
});
</script>

<template>
	<section
		ref="rootEl"
		class="m-3 rounded-xl border border-brand/30 bg-brand/5 p-4"
		:aria-labelledby="titleId"
		:aria-busy="submitting"
		data-testid="ask-card"
	>
		<!-- Every question answered (a draft that failed before it was written):
		     only the retry, which accepts no gaps. -->
		<template v-if="shown.length === 0">
			<div class="flex flex-wrap items-baseline gap-x-2">
				<Icon name="lucide:sparkles" class="size-3.5 self-center text-brand" aria-hidden="true" />
				<h2 :id="titleId" class="text-sm font-semibold text-text-primary">
					{{ t('components.answer.askCard.allAnswered') }}
				</h2>
			</div>
			<UiButton
				type="button"
				size="sm"
				class="mt-3"
				:disabled="submitting"
				data-testid="ask-submit"
				@click="emit('answer', [])"
			>
				<Icon
					v-if="submitting"
					name="lucide:loader-2"
					class="mr-1 size-3.5 animate-spin motion-reduce:animate-none"
					aria-hidden="true"
				/>
				{{ t('components.answer.askCard.draftNow') }}
			</UiButton>
		</template>
		<ClarificationQuestions
			v-else
			ref="listRef"
			:questions="shown"
			require-all
			:submitting="submitting"
			test-id-prefix="ask"
			@submit="onSubmit"
		>
			<template #header>
				<div class="flex flex-wrap items-baseline gap-x-2">
					<Icon name="lucide:sparkles" class="size-3.5 self-center text-brand" aria-hidden="true" />
					<h2 :id="titleId" class="text-sm font-semibold text-text-primary">
						{{ title }}
					</h2>
				</div>
				<p class="mt-0.5 text-xs text-text-secondary" data-testid="ask-subline">
					{{
						teamAgent
							? t('components.answer.askCard.sublineAgent')
							: t('components.answer.askCard.subline')
					}}
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
					:copy-policy="copyPolicy"
					:multiple="multipleFiles"
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
				<div class="mt-4 flex flex-wrap items-center gap-2">
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
						{{
							teamAgent
								? t('components.postbox.postboxClarificationCard.answerLater')
								: t('components.answer.askCard.skip')
						}}
					</UiButton>
				</div>
				<ClarificationTrustLine class="mt-3" :questions="shown" test-id="ask-trust" />
			</template>
		</ClarificationQuestions>
		<p
			v-if="budgetRefused"
			class="mt-3 flex items-start gap-1.5 text-xs text-warning"
			role="status"
			data-testid="ask-budget"
		>
			<Icon name="lucide:wallet" class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
			{{ t('components.answer.askCard.budgetRefused') }}
		</p>
	</section>
</template>
