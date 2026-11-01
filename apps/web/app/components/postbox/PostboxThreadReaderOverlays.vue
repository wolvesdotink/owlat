<script setup lang="ts">
import type { ConversationLinkTarget } from '~/utils/conversationLink';
import type { PostboxReaderMessage } from '~/composables/postbox/postboxReaderMessage';
import type { usePostboxReaderActions } from '~/composables/postbox/usePostboxReaderActions';
import type { usePostboxReaderAttachments } from '~/composables/postbox/usePostboxReaderAttachments';
import type { usePostboxReaderBrief } from '~/composables/postbox/usePostboxReaderBrief';

/**
 * What PostboxThreadReader opens over the conversation: the keyboard-flow
 * pickers for the open message, the full brief, the sender profile, the
 * share-in-chat dialog and the attachment Quick Look. One of each per reader,
 * whichever message card asked for it.
 */
defineProps<{
	mailboxId: string;
	/** The reader's thread-level triage, which owns the pickers' state. */
	actions: ReturnType<typeof usePostboxReaderActions>;
	brief: ReturnType<typeof usePostboxReaderBrief>;
	messages: PostboxReaderMessage[];
	/** Shared mailboxes post the link to team rooms only. */
	shared: boolean;
	attachments: ReturnType<typeof usePostboxReaderAttachments>;
}>();

const briefOpen = defineModel<boolean>('briefOpen', { required: true });
const senderProfile = defineModel<{ fromAddress: string; fromName: string | null } | null>(
	'senderProfile',
	{ required: true }
);
const shareTarget = defineModel<ConversationLinkTarget | null>('shareTarget', { required: true });
</script>

<template>
	<!-- Keyboard-flow pickers for the open message (h / l / v). -->
	<PostboxSnoozeDialog
		:open="actions.snoozeDialogOpen.value"
		:hint-text="actions.snoozeHintText.value"
		scoped
		@update:open="actions.snoozeDialogOpen.value = $event"
		@confirm="actions.snoozeOpenMessage"
		@confirm-until-reply="actions.snoozeOpenMessageUntilReply"
	/>
	<PostboxLabelPickerDialog
		:open="actions.labelDialogOpen.value"
		:labels="actions.labels.value"
		@update:open="actions.labelDialogOpen.value = $event"
		@pick="actions.applyLabelToOpenMessage"
	/>
	<PostboxMovePickerDialog
		:open="actions.moveDialogOpen.value"
		:folders="actions.movableFolders.value"
		@update:open="actions.moveDialogOpen.value = $event"
		@pick="actions.moveOpenMessageTo"
	/>

	<!-- "Full brief": the whole brief card beside the conversation. -->
	<PostboxBriefSheet v-model:open="briefOpen" :state="brief" :messages="messages" />

	<!-- Plan idea 45: one slide-over for whichever sender line was clicked. -->
	<PostboxSenderProfile
		v-if="senderProfile"
		:open="true"
		:mailbox-id="mailboxId"
		:from-address="senderProfile.fromAddress"
		:from-name="senderProfile.fromName"
		@update:open="(open: boolean) => !open && (senderProfile = null)"
	/>

	<LazyChatLinkEmailDialog
		v-if="shareTarget"
		:conversation="shareTarget"
		:audience="shared ? 'shared' : 'personal'"
		@close="shareTarget = null"
	/>

	<!-- Quick Look overlay for image/PDF attachments (Teleports to body). -->
	<PostboxAttachmentLightbox
		v-if="attachments.lightbox.value"
		:attachments="attachments.lightbox.value.attachments"
		:initial-index="attachments.lightbox.value.index"
		:load-part="attachments.loadLightboxPart"
		@close="attachments.lightbox.value = null"
		@download="attachments.downloadLightboxAttachment"
	/>
</template>
