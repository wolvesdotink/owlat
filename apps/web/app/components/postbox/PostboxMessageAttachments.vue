<script setup lang="ts">
import type { AttachmentMeta } from '~/utils/attachmentMeta';
import { notIndexedNoticeKey, type AttachmentIndexing } from '~/utils/attachmentIndexing';

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
 *
 * Hosted-MX mail records what the assistant did with the files
 * (`mailMessages.attachmentIndexing`), and a file it did not read says why,
 * with the Team inbox's sentence for the same marker. Synced and imported mail
 * carries no marker and shows no line.
 */
const props = withDefaults(
	defineProps<{
		attachments: AttachmentMeta[];
		/** `${messageId}:${part}` of the attachment being fetched right now, if any. */
		downloadingKey?: string | null;
		/** This message's id — the first half of `downloadingKey`. */
		messageId: string;
		/** Offer Quick Look. Off for parts a shown signature does not cover: download only. */
		isPreviewEnabled?: boolean;
		/** What the assistant did with these files, when the delivery recorded it. */
		indexing?: AttachmentIndexing;
	}>(),
	{ isPreviewEnabled: true }
);

const emit = defineEmits<{
	(e: 'preview', att: AttachmentMeta, all: AttachmentMeta[]): void;
	(e: 'download', att: AttachmentMeta): void;
}>();

const { t } = useI18n();

const notice = computed(() => {
	const key = notIndexedNoticeKey(props.indexing);
	return key ? [t(key)] : null;
});

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
		:is-preview-enabled="isPreviewEnabled"
		:notice="notice"
		notice-tone="muted"
		notice-test-id="postbox-attachments-not-indexed"
		@preview="(att: AttachmentMeta, all: AttachmentMeta[]) => emit('preview', att, all)"
		@download="(att: AttachmentMeta) => emit('download', att)"
	/>
</template>
