<script setup lang="ts">
import ClarificationQuestions from '~/components/agent-tasks/ClarificationQuestions.vue';
import type { ClarificationAnswer, ClarificationQuestionInput } from '~/utils/clarificationAnswers';

/**
 * "The agent needs your input" on a team-inbox message parked in
 * `awaiting_clarification`: the lead, the reply language, a progress pill and
 * the shared question list with every question required (see
 * ClarificationQuestions for why the team inbox needs them all).
 *
 * Questions answer-memory already answered start on the remembered value; the
 * emitted answers say which ones went back untouched (`source: 'memory'`). The
 * page runs the mutation.
 */
const props = defineProps<{
	questions: readonly ClarificationQuestionInput[];
	/** The sender's language code from the classification ("de"), when known. */
	language?: string | undefined;
	submitting?: boolean;
}>();

const emit = defineEmits<{
	(e: 'submit', answers: ClarificationAnswer[]): void;
}>();

const { t, locale } = useI18n();

/** The sender's language as a readable name in the reader's locale ("German"). */
const languageName = computed(() => {
	const code = props.language;
	if (!code) return undefined;
	try {
		return new Intl.DisplayNames([locale.value], { type: 'language' }).of(code) ?? code;
	} catch {
		return code;
	}
});
</script>

<template>
	<div
		class="mt-4 surface-2 rounded-(--radius-card) border-l-2 border-l-brand/60 p-5"
		data-testid="thread-clarification"
	>
		<ClarificationQuestions
			:questions="questions"
			require-all
			numbered
			:submitting="submitting"
			:placeholder="t('dashboard.inbox.detail.answerPlaceholder')"
			test-id-prefix="thread-clarification"
			@submit="emit('submit', $event)"
		>
			<template #header="{ answered, total }">
				<div class="flex items-start justify-between gap-4">
					<div>
						<span class="lp-eyebrow">{{ t('dashboard.inbox.detail.agentNeedsInputEyebrow') }}</span>
						<p class="mt-1 text-md font-semibold text-text-primary">
							{{ t('dashboard.inbox.detail.agentNeedsInput') }}
						</p>
						<p class="mt-1 text-sm text-text-secondary max-w-[540px]">
							{{ t('dashboard.inbox.detail.clarificationLead') }}
							<template v-if="languageName">
								{{ t('dashboard.inbox.detail.replyLanguageNote', { language: languageName }) }}
							</template>
						</p>
					</div>
					<span
						class="shrink-0 inline-flex items-center gap-1.5 rounded-full surface-1 px-2.5 py-1 text-2xs font-medium text-text-secondary"
						data-testid="thread-clarification-progress"
					>
						<Icon name="lucide:message-circle-question" class="h-3 w-3 text-brand" />
						{{ t('dashboard.inbox.detail.clarificationProgress', { answered, total }) }}
					</span>
				</div>
			</template>
			<template #actions="{ canSubmit, submit, remaining }">
				<div class="flex items-center gap-3 pt-1">
					<UiButton
						size="sm"
						data-testid="thread-clarification-submit"
						:loading="submitting"
						:disabled="!canSubmit"
						@click="submit"
					>
						<Icon name="lucide:sparkles" class="w-3.5 h-3.5" />
						{{ t('dashboard.inbox.detail.answerAndResume') }}
					</UiButton>
					<p
						v-if="remaining > 0"
						class="text-xs text-text-tertiary"
						data-testid="thread-clarification-remaining"
					>
						{{ t('dashboard.inbox.detail.answerRemaining', { count: remaining }, remaining) }}
					</p>
				</div>
			</template>
		</ClarificationQuestions>
	</div>
</template>
