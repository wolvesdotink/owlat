<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';
import TaskActions from '~/components/agent-tasks/TaskActions.vue';
import TaskAsk from '~/components/agent-tasks/TaskAsk.vue';
import TaskCardShell from '~/components/agent-tasks/TaskCardShell.vue';
import TaskContext from '~/components/agent-tasks/TaskContext.vue';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import type { AnswerCardControls } from '~/utils/answerCard';

type MentionEntry = FunctionReturnType<typeof api.chat.mentions.listMyUnreadMentions>[number];

/**
 * A teammate asked the viewer something in chat. Answering happens in chat
 * itself (Enter opens the conversation), or the mention can be marked read.
 * A mention inside an email's team discussion opens that email instead.
 */
const props = defineProps<{ mention: MentionEntry; controls: AnswerCardControls }>();
const { t } = useI18n();

const { run: markRead } = useBackendOperation(api.chat.mentions.markMentionRead, {
	label: () => t('components.answer.mention.markReadOperation'),
});

const target = computed(() => {
	// A mention inside an email's team discussion carries that email's thread.
	const thread = (
		props.mention as { mailThread?: { latestMessageId: string; mailboxId: string } | null }
	).mailThread;
	if (thread)
		return `/dashboard/postbox/inbox/${thread.latestMessageId}?mailbox=${thread.mailboxId}`;
	return `/dashboard/chat/${props.mention.roomId}`;
});

async function reply() {
	await markRead({ mentionId: props.mention._id as Id<'chatMentions'> });
	props.controls.complete('opened');
	void navigateTo(target.value);
}
async function dismiss() {
	const result = await markRead({ mentionId: props.mention._id as Id<'chatMentions'> });
	if (result.ok) props.controls.complete('cleared');
}

function onKeydown(event: KeyboardEvent) {
	if (event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) return;
	if (event.key === 'Enter') {
		event.preventDefault();
		void reply();
	} else if (event.key === 'd') {
		event.preventDefault();
		void dismiss();
	} else if (event.key === 's') {
		event.preventDefault();
		props.controls.skip();
	}
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
	<TaskCardShell>
		<TaskContext
			:who="`#${mention.roomName}`"
			icon="lucide:message-circle"
			:meta="formatCompactRelativeTime(mention.createdAt)"
		/>
		<TaskAsk class="mt-3 mb-4" :ask="mention.messagePreview" />
		<TaskActions
			:primary-label="t('components.answer.mention.reply')"
			primary-icon="lucide:message-circle"
			:skip-label="t('components.answer.mention.markRead')"
			:hints="[
				{ keys: ['Enter'], label: t('components.answer.mention.reply') },
				{ keys: ['d'], label: t('components.answer.mention.markRead') },
			]"
			@primary="reply"
			@skip="dismiss"
		/>
	</TaskCardShell>
</template>
