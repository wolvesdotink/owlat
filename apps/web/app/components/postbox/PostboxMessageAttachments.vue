<script setup lang="ts">
import type { MessageAttachmentMeta } from '~/components/mail/MessageAttachmentList.vue';

/**
 * The attachment rows under one Postbox message: name, size, type, an eye for
 * the previewable ones (images and PDFs open in the reader's Quick Look
 * overlay) and a download.
 *
 * The rows are `mail/MessageAttachmentList.vue`, shared with the team-inbox
 * reader; this wrapper supplies the Postbox copy and turns Quick Look on.
 * Extraction only — both verbs are emitted, because extracting a MIME part
 * means fetching the raw `.eml`, and that (with its spinner, its toast and its
 * object-URL lifetime) belongs to the reader, which already owns it for the
 * lightbox.
 */
export type PostboxAttachmentMeta = MessageAttachmentMeta;

defineProps<{
	attachments: PostboxAttachmentMeta[];
	/** `${messageId}:${part}` of the attachment being fetched right now, if any. */
	downloadingKey?: string | null;
	/** This message's id — the first half of `downloadingKey`. */
	messageId: string;
}>();

const emit = defineEmits<{
	(e: 'preview', att: PostboxAttachmentMeta, all: PostboxAttachmentMeta[]): void;
	(e: 'download', att: PostboxAttachmentMeta): void;
}>();

const { t } = useI18n();

function downloadLabel(filename: string): string {
	return t('components.postbox.postboxThreadReader.downloadAttachment', { filename });
}

function previewLabel(filename: string): string {
	return t('components.postbox.postboxThreadReader.previewAttachment', { filename });
}
</script>

<template>
	<MailMessageAttachmentList
		:attachments="attachments"
		:message-id="messageId"
		:downloading-key="downloadingKey"
		:download-label="downloadLabel"
		:preview-label="previewLabel"
		is-preview-enabled
		@preview="
			(att: PostboxAttachmentMeta, all: PostboxAttachmentMeta[]) => emit('preview', att, all)
		"
		@download="(att: PostboxAttachmentMeta) => emit('download', att)"
	/>
</template>
