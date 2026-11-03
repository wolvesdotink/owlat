<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';
import TaskActions from '~/components/agent-tasks/TaskActions.vue';
import TaskAsk from '~/components/agent-tasks/TaskAsk.vue';
import TaskCardShell from '~/components/agent-tasks/TaskCardShell.vue';
import TaskContext from '~/components/agent-tasks/TaskContext.vue';
import { useKeyboardShortcuts } from '~/composables/useKeyboardShortcuts';
import { useShortcutLabels } from '~/composables/useShortcutLabels';
import { useShortcutScope } from '~/composables/useShortcutScope';
import type { AnswerCardControls } from '~/utils/answerCard';
import { ChatCircleIcon } from '@coolicons/vue';

type MentionEntry = FunctionReturnType<typeof api.chat.mentions.listMyUnreadMentions>[number];

/**
 * A teammate asked the viewer something in chat. Answering happens in chat
 * itself (Enter opens the conversation), or the mention can be marked read.
 * A mention inside an email's team discussion opens that email instead.
 *
 * Keys (the `mentionCard` scope): Enter opens it, `d` marks it read, `s`
 * skips it for now.
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

useShortcutScope('mentionCard');
const { registerShortcut } = useKeyboardShortcuts();
registerShortcut({ id: 'mentionCard.reply', handler: () => void reply() });
registerShortcut({ id: 'mentionCard.markRead', handler: () => void dismiss() });
registerShortcut({ id: 'mentionCard.skip', handler: () => props.controls.skip() });

// The hints follow the person's keys.
const { keyHints } = useShortcutLabels();
const hints = computed(() =>
	keyHints([
		{ id: 'mentionCard.reply', label: t('components.answer.mention.reply') },
		{ id: 'mentionCard.markRead', label: t('components.answer.mention.markRead') },
	])
);
</script>

<template>
	<TaskCardShell>
		<TaskContext
			:who="`#${mention.roomName}`"
			:icon="ChatCircleIcon"
			:meta="formatCompactRelativeTime(mention.createdAt)"
		/>
		<TaskAsk class="mt-3 mb-4" :ask="mention.messagePreview" />
		<TaskActions
			:primary-label="t('components.answer.mention.reply')"
			:primary-icon="ChatCircleIcon"
			:skip-label="t('components.answer.mention.markRead')"
			:hints="hints"
			@primary="reply"
			@skip="dismiss"
		/>
	</TaskCardShell>
</template>
