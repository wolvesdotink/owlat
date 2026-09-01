<script setup lang="ts">
/**
 * The attachment rows under one message: name, size, type, an eye for the
 * previewable ones (images and PDFs open in the reader's Quick Look overlay)
 * and a download.
 *
 * Extraction only — both verbs are emitted, because extracting a MIME part
 * means fetching the raw `.eml`, and that (with its spinner, its toast and its
 * object-URL lifetime) belongs to the reader, which already owns it for the
 * lightbox.
 */
export type PostboxAttachmentMeta = {
	filename: string;
	contentType: string;
	size: number;
	partIndex?: string;
};

const props = defineProps<{
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

function isPreviewable(contentType: string): boolean {
	return contentType.startsWith('image/') || contentType === 'application/pdf';
}

function isDownloading(att: PostboxAttachmentMeta): boolean {
	return props.downloadingKey === `${props.messageId}:${att.partIndex ?? att.filename}`;
}
</script>

<template>
	<section v-if="attachments.length > 0" class="mt-3">
		<ul class="grid grid-cols-1 sm:grid-cols-2 gap-2">
			<li
				v-for="(att, i) in attachments"
				:key="i"
				class="flex items-center gap-2 px-3 py-2 rounded border border-border-subtle"
			>
				<Icon name="lucide:paperclip" class="w-4 h-4 text-text-tertiary flex-shrink-0" />
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm">{{ att.filename }}</p>
					<p class="text-xs text-text-tertiary">
						{{ formatCompactFileSize(att.size) }} · {{ att.contentType }}
					</p>
				</div>
				<button
					v-if="isPreviewable(att.contentType)"
					type="button"
					class="p-1 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary"
					:title="
						t('components.postbox.postboxThreadReader.previewAttachment', {
							filename: att.filename,
						})
					"
					:aria-label="
						t('components.postbox.postboxThreadReader.previewAttachment', {
							filename: att.filename,
						})
					"
					@click="emit('preview', att, attachments)"
				>
					<Icon name="lucide:eye" class="w-4 h-4" />
				</button>
				<button
					type="button"
					class="p-1 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary disabled:opacity-50"
					:title="
						t('components.postbox.postboxThreadReader.downloadAttachment', {
							filename: att.filename,
						})
					"
					:aria-label="
						t('components.postbox.postboxThreadReader.downloadAttachment', {
							filename: att.filename,
						})
					"
					:disabled="isDownloading(att)"
					@click="emit('download', att)"
				>
					<Icon
						:name="isDownloading(att) ? 'lucide:loader-2' : 'lucide:download'"
						class="w-4 h-4"
						:class="{ 'animate-spin motion-reduce:animate-none': isDownloading(att) }"
					/>
				</button>
			</li>
		</ul>
	</section>
</template>
