<script setup lang="ts">
import type { ComposerSpec } from '~/composables/postbox/usePostboxComposerStack';

defineProps<{
	composer: ComposerSpec;
	index: number;
}>();

const stack = usePostboxComposerStack();
const undoSend = usePostboxUndoSend();

function onSent(composerId: string, undoToken: string, sendAt: number, mailboxId: string) {
	stack.close(composerId);
	undoSend.arm({
		undoToken,
		sendAt,
		mailboxId: mailboxId as import('@owlat/api/dataModel').Id<'mailboxes'>,
	});
}
</script>

<template>
	<div
		v-if="!composer.minimized"
		class="fixed bottom-0 w-[380px] h-[440px] bg-bg-elevated border border-border-subtle rounded-t-md shadow-lg flex flex-col z-40"
		:style="{ right: `${24 + index * 396}px` }"
	>
		<PostboxComposer
			:mailbox-id="composer.mailboxId"
			:draft-id="composer.draftId"
			:in-reply-to-message-id="composer.inReplyToMessageId"
			:prefill-to="composer.prefillTo"
			:prefill-cc="composer.prefillCc"
			:prefill-bcc="composer.prefillBcc"
			:prefill-subject="composer.prefillSubject"
			:prefill-body-html="composer.prefillBodyHtml"
			:forward-attachments-from-message-id="composer.forwardAttachmentsFromMessageId"
			:attach-pending-key="composer.attachPendingKey"
			@sent="(token, sendAt) => onSent(composer.id, token, sendAt, composer.mailboxId)"
			@discarded="stack.close(composer.id)"
			@minimize="stack.minimize(composer.id)"
		/>
	</div>
	<button
		v-else
		type="button"
		class="fixed bottom-0 h-9 px-3 bg-brand text-white rounded-t-md shadow-lg flex items-center gap-2 text-sm z-40"
		:style="{ right: `${24 + index * 220}px` }"
		@click="stack.restore(composer.id)"
	>
		<Icon name="lucide:mail" class="w-4 h-4" />
		<span class="truncate max-w-[160px]">
			{{ composer.prefillSubject || 'Draft' }}
		</span>
	</button>
</template>
