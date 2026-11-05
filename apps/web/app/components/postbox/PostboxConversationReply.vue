<script setup lang="ts">
/**
 * The foot of a conversation opened from the conversation view: a field that
 * says whom a reply goes to, and, when the AI drafted one on arrival, a way to
 * review it. Both open the reply in Answer mode, behind the reader's reply
 * guard (`?reply=1`, usePostboxReaderReplies), where the drafted reply is
 * already in the composer, marked as the AI's, to edit before sending.
 */
import { SparklesIcon } from '@coolicons/vue';
import { POSTBOX_TOPIC_HEADING } from '~/utils/postboxPeople';

const { t } = useI18n();
const injected = inject(POSTBOX_TOPIC_HEADING, null);
const heading = computed(() => injected?.value ?? null);
const route = useRoute();

function reply() {
	void navigateTo({ query: { ...route.query, reply: '1' } }, { replace: true });
}
</script>

<template>
	<div v-if="heading?.hasReplyField" class="mx-auto flex max-w-4xl flex-wrap gap-2.5 px-6 pb-12">
		<button
			type="button"
			class="flex min-h-12 min-w-[14rem] flex-1 items-center rounded-xl border border-border-default bg-bg-base px-3.5 text-left text-sm text-text-tertiary transition-colors hover:border-border-strong hover:text-text-secondary"
			@click="reply"
		>
			<span>{{
				heading.replyTo
					? t('components.postbox.conversations.reply.to', { name: heading.replyTo })
					: t('components.postbox.conversations.reply.plain')
			}}</span>
		</button>
		<button
			v-if="heading.hasSuggestedReply"
			type="button"
			class="flex min-h-12 items-center gap-1.5 rounded-xl border border-brand-border bg-brand-soft px-3.5 text-[0.8125rem] font-semibold text-brand-muted transition-colors hover:border-brand"
			@click="reply"
		>
			<SparklesIcon class="h-4 w-4" />
			{{ t('components.postbox.conversations.reply.suggested') }}
		</button>
	</div>
</template>
