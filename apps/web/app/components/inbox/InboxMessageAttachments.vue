<script setup lang="ts">
import type { Doc } from '@owlat/api/dataModel';
import { formatCompactFileSize } from '~/utils/formatters';
import { parseInboundAttachmentMeta } from '~/utils/inboundAttachmentMeta';
import { loadInboundRawEml } from '~/composables/loadInboundRawEml';
import { useMimePartDownload } from '~/composables/useMimePartDownload';

/**
 * The attachment rows under one team-inbox message.
 *
 * The rows themselves are `mail/MessageAttachmentList.vue`, shared with the
 * Postbox reader; this wrapper supplies the team-inbox copy, decides which
 * state the message is in, and owns the download.
 *
 * TAKES THE ROW, not eight fields off it. Which column means "gone", which
 * means "swept" and which means "unread" is this component's business, and
 * spelling the mapping out at the call site put it in a 1000-line page where a
 * `!!` instead of a `!` would have rendered every message as never-stored with
 * nothing to catch it. Downloading means fetching the raw `.eml` and extracting
 * the part client-side — `useMimePartDownload`, shared with the Postbox reader,
 * pointed at the inbound loader.
 *
 * Four states, because an attachment listed here is not always fetchable, and
 * a fetchable one has not always been read by the assistant:
 *   · normal — the row downloads and the file was indexed;
 *   · BLOCKED — malware was found in this message, so there is no download
 *     control at all, not a disabled one;
 *   · GONE — the bytes are not stored. The copy says whether the retention
 *     sweep RELEASED them (`rawReleasedAt` is set) or they simply were not
 *     kept: telling someone a retention window expired on a message from last
 *     week is false, and so is telling them a message that arrived today
 *     predates the feature when the truth is that its payload was oversized;
 *   · NOT INDEXED — the file is here and downloadable, but the assistant did
 *     not read it, or read only its name: no clean malware verdict, an
 *     unverifiable sender, the AI-ingest budget spent, more attachments than
 *     one message is processed for, a file over the processing size limit, a
 *     type the assistant does not read, or a type it can only name. Each says
 *     WHICH, because "not read" and "too big to read" send a reader to
 *     different places. Without this line the row looks identical to an
 *     indexed one while the agent will never surface it in
 *     `[RELEVANT FILES]`.
 */

/**
 * What this component reads off an `inboundMessages` row. A structural subset
 * rather than the whole `Doc`, so a test can build one and the compiler still
 * checks every field against the generated model.
 */
export type InboxMessageFiles = Pick<
	Doc<'inboundMessages'>,
	| '_id'
	| 'attachmentMeta'
	| 'virusVerdict'
	| 'rawStorageId'
	| 'rawReleasedAt'
	| 'rawSize'
	| 'attachmentIndexing'
>;

const props = defineProps<{
	message: InboxMessageFiles;
}>();

const { t } = useI18n();

// `attachmentMeta` is an unvalidated JSON string written from wire data — the
// parser is where it becomes props, and it drops anything malformed.
const attachments = computed(() => parseInboundAttachmentMeta(props.message.attachmentMeta));

/**
 * The bytes are not on the message row: they are inside the raw `.eml` the
 * ingest route sealed into storage. A download fetches that once (the loader
 * caches per message) and extracts the named MIME part client-side.
 */
const { downloadingAttachment, handleAttachmentDownload } = useMimePartDownload({
	loadRaw: loadInboundRawEml,
	failureKey: 'components.inbox.inboxMessageAttachments.downloadFailed',
});

/** No `rawStorageId` means the bytes are gone — swept, or never kept. */
const isRawGone = computed(() => !props.message.rawStorageId);
const isBlocked = computed(() => props.message.virusVerdict === 'infected');

/**
 * Every marker that is not a plain `indexed`, and the line it renders.
 *
 * TOTAL OVER THE UNION, not `Record<string, string>`: the marker comes from
 * `attachmentIndexingValidator`, and an untyped table let a new member compile
 * everywhere and then render as nothing — a row that looks exactly like a file
 * the assistant read, which is the defect these lines exist to close.
 */
type NotIndexedMarker = Exclude<NonNullable<InboxMessageFiles['attachmentIndexing']>, 'indexed'>;

const NOT_INDEXED_KEYS: Record<NotIndexedMarker, string> = {
	indexed_placeholder: 'notIndexedPlaceholder',
	skipped_unscanned: 'notScanned',
	skipped_unverified: 'notIndexedUnverified',
	skipped_budget: 'notIndexed',
	skipped_cap: 'notIndexedCap',
	skipped_too_large: 'notIndexedTooLarge',
	skipped_unsupported: 'notIndexedUnsupported',
};

/**
 * The line above the rows. At most one state shows, ordered by how much it
 * changes what the reader can do: blocked, then gone, then not-indexed.
 *
 * `text` is an ARRAY of whole sentences, not a concatenation: the gone line can
 * be followed by the original size, and gluing two translated strings together
 * with a hardcoded space decides word order and spacing for every locale at
 * once. The template renders them as siblings instead.
 */
const notice = computed<{ text: string[]; tone: 'warning' | 'muted'; testId: string } | null>(
	() => {
		if (isBlocked.value) {
			return {
				text: [t('components.inbox.inboxMessageAttachments.blocked')],
				tone: 'warning',
				testId: 'inbox-attachments-blocked',
			};
		}
		if (isRawGone.value) {
			// The sweep keeps `rawSize` when it releases the bytes, so the line can
			// still say how big the message was — a fact, rather than an absence.
			const base = props.message.rawReleasedAt
				? t('components.inbox.inboxMessageAttachments.released')
				: t('components.inbox.inboxMessageAttachments.neverStored');
			const size = props.message.rawSize
				? [
						t('components.inbox.inboxMessageAttachments.originalSize', {
							size: formatCompactFileSize(props.message.rawSize),
						}),
					]
				: [];
			return { text: [base, ...size], tone: 'muted', testId: 'inbox-attachments-gone' };
		}
		const marker = props.message.attachmentIndexing;
		const notIndexedKey = marker && marker !== 'indexed' ? NOT_INDEXED_KEYS[marker] : undefined;
		if (notIndexedKey) {
			return {
				text: [t(`components.inbox.inboxMessageAttachments.${notIndexedKey}`)],
				tone: 'muted',
				testId: 'inbox-attachments-not-indexed',
			};
		}
		return null;
	}
);

function downloadLabel(filename: string): string {
	return t('components.inbox.inboxMessageAttachments.download', { filename });
}
</script>

<template>
	<MailMessageAttachmentList
		:attachments="attachments"
		:message-id="message._id"
		:downloading-key="downloadingAttachment"
		:heading="t('components.inbox.inboxMessageAttachments.heading')"
		:notice="notice?.text ?? null"
		:notice-tone="notice?.tone"
		:notice-test-id="notice?.testId"
		:is-download-hidden="isBlocked"
		:is-download-disabled="isRawGone"
		:download-label="downloadLabel"
		test-id="inbox-message-attachments"
		@download="(att) => handleAttachmentDownload(message._id, att)"
	/>
</template>
