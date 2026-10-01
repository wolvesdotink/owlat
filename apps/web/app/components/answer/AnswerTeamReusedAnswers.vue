<script setup lang="ts">
import {
	localizedQuestionCopy,
	type LocalizableClarificationQuestion,
} from '~/utils/clarificationLocale';

/**
 * The answers the agent reused from memory for the draft in the editor, above
 * it in the team reply: answer memory is visible, never silent. Moved here
 * from the thread page with the rest of the reply.
 */
defineProps<{
	questions: readonly (LocalizableClarificationQuestion & {
		id: string;
		answer?: { value: string } | undefined;
	})[];
}>();

const { t, locale } = useI18n();
</script>

<template>
	<div class="surface-1 rounded-(--radius-card) p-4" data-testid="reused-answers">
		<span class="lp-eyebrow">{{ t('dashboard.inbox.detail.reusedAnswersEyebrow') }}</span>
		<p class="mt-1 text-sm font-medium text-text-primary">
			{{ t('dashboard.inbox.detail.reusedAnswersTitle') }}
		</p>
		<ul class="mt-2 space-y-1.5 text-sm">
			<li v-for="question in questions" :key="question.id" class="flex items-baseline gap-2">
				<Icon
					name="lucide:history"
					class="w-3.5 h-3.5 shrink-0 translate-y-0.5 text-text-tertiary"
				/>
				<span class="text-text-secondary">{{ localizedQuestionCopy(question, locale).text }}</span>
				<span class="font-medium text-text-primary">{{ question.answer?.value }}</span>
			</li>
		</ul>
		<p class="mt-2 text-xs text-text-tertiary">
			{{ t('dashboard.inbox.detail.reusedAnswersHint') }}
			<NuxtLink
				to="/dashboard/admin/instance/ai-replies"
				class="underline hover:text-text-primary"
				>{{ t('dashboard.inbox.detail.reusedAnswersManage') }}</NuxtLink
			>
		</p>
	</div>
</template>
