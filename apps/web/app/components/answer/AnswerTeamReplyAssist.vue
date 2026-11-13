<script setup lang="ts">
/**
 * What sits above the team reply's editor in Answer mode: the agent's own
 * questions when it is waiting on them (answering resumes its draft), and
 * otherwise the response plan, the answers reused from earlier questions and
 * Draft with AI (its ask card while it asks, its bar the rest of the time).
 * The reply and the assist are the page's (`useAnswerTeamReply`,
 * `useAnswerTeamAssist`); `composer` is the editor the AI draft lands in.
 */
import type { BriefContext } from '~/utils/threadBriefContext';
import type { AnswerComposerApi } from '~/composables/postbox/usePostboxComposerAnswerApi';
import type { AskAnswer, AskQuestion } from '~/composables/useAnswerAskSession';
import type { useAnswerTeamAssist } from '~/composables/useAnswerTeamAssist';
import type { useAnswerTeamReply } from '~/composables/useAnswerTeamReply';
import AnswerAiBar from './AnswerAiBar.vue';
import AskCard from './AskCard.vue';
import type { FileCopyPolicy } from './FileAsk.vue';

const props = defineProps<{
	reply: ReturnType<typeof useAnswerTeamReply>;
	assist: ReturnType<typeof useAnswerTeamAssist>;
	composer: AnswerComposerApi;
	copyPolicy: FileCopyPolicy;
	canAttach: boolean;
	citeContext?: BriefContext;
}>();

const emit = defineEmits<{ files: [files: File[]] }>();

const { t, locale } = useI18n();

// The agent's questions carry the ask card's shape (lib/validators/clarification.ts).
const clarificationQuestions = computed(
	() => (props.reply.clarification.value?.questions ?? []) as unknown as AskQuestion[]
);
// The sender's language as a readable name in the reader's locale ("German").
const replyLanguage = computed(() => {
	const code = props.reply.target.value?.classification?.language;
	if (!code) return undefined;
	try {
		return new Intl.DisplayNames([locale.value], { type: 'language' }).of(code) ?? code;
	} catch {
		return code;
	}
});
const showClarification = computed(() => !!props.reply.clarification.value);
// A file given as an answer goes on the reply on the server, in the same
// transaction as the answer (inbox.clarification.answerClarification); the
// attachment list then updates through its subscription. "Draft with what I
// have" sends what was answered and lets the rest become highlighted gaps.
async function onClarificationAnswers(answers: AskAnswer[], withGaps = false) {
	await props.reply.submitClarification(answers, withGaps);
}
</script>

<template>
	<!-- The agent's own questions come first: answering resumes its draft. -->
	<div v-if="showClarification" data-testid="answer-team-clarification">
		<p
			v-if="replyLanguage"
			class="px-3 pt-3 text-xs text-text-tertiary"
			data-testid="answer-team-reply-language"
		>
			{{ t('dashboard.inbox.detail.replyLanguageNote', { language: replyLanguage }) }}
		</p>
		<AskCard
			:questions="clarificationQuestions"
			:copy-policy="copyPolicy"
			:submitting="reply.isAnsweringClarification.value"
			@answer="onClarificationAnswers"
			@skip="onClarificationAnswers($event, true)"
		/>
	</div>
	<template v-else>
		<AnswerTeamPlan
			:plan="assist.plan"
			:can-attach="canAttach"
			:cite-context="citeContext"
			@files="emit('files', $event)"
		/>
		<AnswerTeamReusedAnswers
			v-if="reply.reusedAnswers.value.length > 0"
			:questions="reply.reusedAnswers.value"
		/>
		<template v-if="assist.draftWithAi.value">
			<AskCard
				v-if="assist.ask.phase.value === 'asking' && assist.ask.session.value"
				:questions="assist.ask.session.value.questions"
				:copy-policy="copyPolicy"
				:submitting="assist.ask.busy.value"
				:budget-refused="assist.ask.isBudgetRefused.value"
				@answer="assist.ask.answer($event)"
				@skip="assist.ask.answer($event, true)"
			/>
			<AnswerAiBar
				v-else
				:phase="assist.ask.phase.value"
				:busy="assist.ask.busy.value"
				:has-ai-draft="composer.aiDraft.value !== null"
				:injection-flagged="assist.ask.injectionFlagged.value"
				@draft="assist.ask.start"
				@discard="composer.discardAiDraft()"
			/>
		</template>
	</template>
</template>
