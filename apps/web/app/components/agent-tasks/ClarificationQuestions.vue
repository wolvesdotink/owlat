<script setup lang="ts">
import TaskAsk from '~/components/agent-tasks/TaskAsk.vue';
import TaskOptions from '~/components/agent-tasks/TaskOptions.vue';
import { localizedQuestionCopy } from '~/utils/clarificationLocale';
import {
	canSubmitClarification,
	collectClarificationAnswers,
	isAnswered,
	rememberedDisplayAnswer,
	type ClarificationAnswer,
	type ClarificationQuestionInput,
} from '~/utils/clarificationAnswers';

/**
 * The question list of a clarification loop: each question in the reader's
 * language, its option chips and a free-text box (TaskAsk + TaskOptions).
 * Both surfaces render it: the Postbox "Needs your input" card and the
 * team-inbox thread page.
 *
 * It owns the working values and the completeness rule, and emits `submit`
 * with canonical values and their source (utils/clarificationAnswers).
 * A question answer-memory already answered starts on the remembered value,
 * tagged on its chip; submitting it untouched sends it back as `memory`.
 *
 * `requireAll` is the one place the two surfaces differ, on purpose:
 *   - Team inbox (true): answering resumes the agent's draft once, with the
 *     answers as confirmed facts, and that draft can go out automatically. A
 *     question left open would reach the draft as a guess.
 *   - Postbox (false): the answers seed a starter reply that opens in the
 *     composer, where the owner reads and edits it before sending. One answer
 *     is enough to start, and only the answered questions are sent.
 *
 * The `header` and `actions` slots receive `{ answered, total, remaining,
 * canSubmit, submit }`, so each surface keeps its own progress line and
 * buttons. `pickIndex` and `submit` are exposed for card keyboards.
 *
 * The `answer` slot replaces the chips-and-text input of a question, for a
 * surface that answers some kinds differently (Answer mode's date and file
 * questions). It gets `{ question, index, copy, remembered, value, setValue }`;
 * whatever it sets is the working value the rules above count and submit.
 */
const props = withDefaults(
	defineProps<{
		questions: readonly ClarificationQuestionInput[];
		requireAll: boolean;
		submitting?: boolean;
		/**
		 * The page layout: a "Question 1 of 3" line above each question and a
		 * divider between them. Off, the questions stack as card rows.
		 */
		numbered?: boolean;
		placeholder?: string;
		/** data-testid prefix: `<prefix>-question`, `<prefix>-chip`, `<prefix>-input`. */
		testIdPrefix?: string;
		/**
		 * Leave each question's attribution line out: the surface says where the
		 * questions came from once, for all of them (Answer mode's ask card).
		 */
		hideAttribution?: boolean;
	}>(),
	{
		submitting: false,
		numbered: false,
		placeholder: undefined,
		testIdPrefix: 'clarification',
		hideAttribution: false,
	}
);

const emit = defineEmits<{
	(e: 'submit', answers: ClarificationAnswer[]): void;
}>();

const { t, locale } = useI18n();

const copyFor = (question: ClarificationQuestionInput) =>
	localizedQuestionCopy(question, locale.value);
const rememberedFor = (question: ClarificationQuestionInput) =>
	rememberedDisplayAnswer(question, locale.value);

// Per-question working value (chip pick or typed text), keyed by question id.
// A question answer-memory filled starts on the remembered value, once: a
// later re-render never overwrites what the person picked or typed.
const values = reactive<Record<string, string>>({});
watch(
	() => props.questions,
	(questions) => {
		for (const question of questions) {
			if (values[question.id] !== undefined) continue;
			const remembered = rememberedFor(question);
			if (remembered !== undefined) values[question.id] = remembered;
		}
	},
	{ immediate: true }
);

const answered = computed(() => props.questions.filter((q) => isAnswered(values, q.id)).length);
const total = computed(() => props.questions.length);
const canSubmit = computed(
	() => !props.submitting && canSubmitClarification(props.questions, values, props.requireAll)
);

function submit() {
	if (!canSubmit.value) return;
	const answers = collectClarificationAnswers(props.questions, values, locale.value);
	if (answers.length > 0) emit('submit', answers);
}

// 1–9 picks a chip on the first question that offers options: the common case
// is a single question; multi-question lists keep chips clickable per question.
const optionRefs = ref<InstanceType<typeof TaskOptions>[]>([]);
function pickIndex(index: number) {
	const qi = props.questions.findIndex((q) => (q.options?.length ?? 0) > 0);
	if (qi >= 0) optionRefs.value[qi]?.pickIndex(index);
}

function setValue(questionId: string, value: string) {
	values[questionId] = value;
}

defineExpose({ pickIndex, submit, setValue });
</script>

<template>
	<slot
		name="header"
		:answered="answered"
		:total="total"
		:remaining="total - answered"
		:can-submit="canSubmit"
		:submit="submit"
	/>
	<div :class="numbered ? 'mt-5 space-y-5' : undefined">
		<div
			v-for="(question, qi) in questions"
			:key="question.id"
			:data-testid="`${testIdPrefix}-question`"
			:class="numbered ? 'border-t border-border-subtle pt-4' : 'mt-2'"
		>
			<p v-if="numbered" class="lp-eyebrow mb-1.5">
				{{
					t('components.agentTasks.clarificationQuestions.questionCounter', {
						index: qi + 1,
						total,
					})
				}}
			</p>
			<TaskAsk
				:ask="copyFor(question).text"
				:why="hideAttribution ? undefined : question.attribution"
			/>
			<slot
				name="answer"
				:question="question"
				:index="qi"
				:copy="copyFor(question)"
				:remembered="rememberedFor(question)"
				:value="values[question.id] ?? ''"
				:set-value="(value: string) => setValue(question.id, value)"
			>
				<TaskOptions
					:ref="(el) => (optionRefs[qi] = el as InstanceType<typeof TaskOptions>)"
					v-model="values[question.id]"
					class="mt-1.5"
					:options="copyFor(question).options"
					:remembered="rememberedFor(question)"
					:placeholder="placeholder"
					:chip-test-id="`${testIdPrefix}-chip`"
					:input-test-id="`${testIdPrefix}-input`"
					@submit="submit"
				/>
			</slot>
		</div>
		<slot
			name="actions"
			:answered="answered"
			:total="total"
			:remaining="total - answered"
			:can-submit="canSubmit"
			:submit="submit"
		/>
	</div>
</template>
