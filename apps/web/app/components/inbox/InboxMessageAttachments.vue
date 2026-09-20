<script setup lang="ts">
import { formatCompactFileSize } from '~/utils/formatters';
import type { MessageAttachmentMeta } from '~/components/mail/MessageAttachmentList.vue';

/**
 * The attachment rows under one team-inbox message.
 *
 * The rows themselves are `mail/MessageAttachmentList.vue`, shared with the
 * Postbox reader; this wrapper supplies the team-inbox copy and decides which
 * state the message is in. Downloading means fetching the raw `.eml` and
 * extracting the part client-side, which belongs to the page — see
 * `useMimePartDownload`.
 *
 * Four states, because an attachment listed here is not always fetchable, and
 * a fetchable one has not always been read by the assistant:
 *   · normal — the row downloads and the file was indexed;
 *   · BLOCKED — malware was found in this message, so there is no download
 *     control at all, not a disabled one;
 *   · GONE — the bytes are not stored. Either the retention sweep released
 *     them (`releasedAt` is set) or this message arrived before the route
 *     carried them. The copy says WHICH: telling someone a retention window
 *     expired on a message from last week is simply false;
 *   · NOT INDEXED — the file is here and downloadable, but the assistant never
 *     read it (no clean malware verdict, or the AI-ingest budget was spent).
 *     Without this line the row looks identical to an indexed one while the
 *     agent will never surface it in `[RELEVANT FILES]`.
 */
export type InboxAttachmentMeta = MessageAttachmentMeta;

const props = defineProps<{
	attachments: InboxAttachmentMeta[];
	/** This message's id — the first half of `downloadingKey`. */
	messageId: string;
	/** `${messageId}:${part}` of the attachment being fetched right now, if any. */
	downloadingKey?: string | null;
	/** Aggregate malware verdict for the message these parts came from. */
	virusVerdict?: 'clean' | 'infected' | 'skipped';
	/** The message's stored files are gone — swept, or never carried. */
	isExpired?: boolean;
	/** When the retention sweep released them, if it was the sweep that did. */
	releasedAt?: number;
	/** Size of the original message in bytes; survives the sweep. */
	rawSize?: number;
	/** What attachment capture did with these files. */
	attachmentIndexing?: 'indexed' | 'skipped_budget' | 'skipped_unscanned';
}>();

const emit = defineEmits<{
	(e: 'download', att: InboxAttachmentMeta): void;
}>();

const { t } = useI18n();

const isBlocked = computed(() => props.virusVerdict === 'infected');

/**
 * The one line above the rows. At most one shows, ordered by how much it
 * changes what the reader can do: blocked, then gone, then not-indexed.
 */
const notice = computed<{ text: string; tone: 'warning' | 'muted'; testId: string } | null>(() => {
	if (isBlocked.value) {
		return {
			text: t('components.inbox.inboxMessageAttachments.blocked'),
			tone: 'warning',
			testId: 'inbox-attachments-blocked',
		};
	}
	if (props.isExpired) {
		// The sweep keeps `rawSize` when it releases the bytes, so the line can
		// still say how big the message was — a fact, rather than an absence.
		const base = props.releasedAt
			? t('components.inbox.inboxMessageAttachments.released')
			: t('components.inbox.inboxMessageAttachments.neverStored');
		const size = props.rawSize
			? ` ${t('components.inbox.inboxMessageAttachments.originalSize', {
					size: formatCompactFileSize(props.rawSize),
				})}`
			: '';
		return { text: `${base}${size}`, tone: 'muted', testId: 'inbox-attachments-expired' };
	}
	if (props.attachmentIndexing === 'skipped_unscanned') {
		return {
			text: t('components.inbox.inboxMessageAttachments.notScanned'),
			tone: 'muted',
			testId: 'inbox-attachments-not-indexed',
		};
	}
	if (props.attachmentIndexing === 'skipped_budget') {
		return {
			text: t('components.inbox.inboxMessageAttachments.notIndexed'),
			tone: 'muted',
			testId: 'inbox-attachments-not-indexed',
		};
	}
	return null;
});

function downloadLabel(filename: string): string {
	return t('components.inbox.inboxMessageAttachments.download', { filename });
}
</script>

<template>
	<MailMessageAttachmentList
		:attachments="attachments"
		:message-id="messageId"
		:downloading-key="downloadingKey"
		:heading="t('components.inbox.inboxMessageAttachments.heading')"
		:notice="notice?.text ?? null"
		:notice-tone="notice?.tone"
		:notice-test-id="notice?.testId"
		:is-download-hidden="isBlocked"
		:is-download-disabled="isExpired"
		:download-label="downloadLabel"
		test-id="inbox-message-attachments"
		@download="(att: InboxAttachmentMeta) => emit('download', att)"
	/>
</template>
