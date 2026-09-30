<script setup lang="ts">
/**
 * Answer mode's left column: the conversation being answered, newest last
 * (plan §03, v1).
 *
 * The same thread paging and the same message card the reader uses, with the
 * card's chrome cut (`reduced`): no per-message action row, the trust chip only
 * when something is off, recipients and details behind the sender name. Older
 * messages are one-line rows; the newest and the unread ones open in full.
 *
 * Two views, one toggle (the page binds `t`): "summary" is that default,
 * "full" opens every loaded message. The catch-up card of a long thread slots
 * in above the messages (`#catch-up`); this column only reserves the place.
 */
import type { Id } from '@owlat/api/dataModel';
import { api } from '@owlat/api';
import { extractEmailAddress } from '~/utils/emailAddress';
import { formatCompactRelativeTime } from '~/utils/formatters';
import { useNow } from '~/composables/useNow';
import { placeAnchorRow } from '~/composables/postbox/postboxThreadPage';
import {
	initialExpandedIds,
	usePostboxReaderExpansion,
} from '~/composables/postbox/usePostboxReaderExpansion';
import { usePostboxReaderOpenRow } from '~/composables/postbox/usePostboxReaderOpenRow';
import {
	usePostboxEnvelopeBodies,
	usePostboxThreadPages,
} from '~/composables/postbox/usePostboxThreadPages';
import { classifySecureMessage, isEncryptedClass } from '@owlat/shared/secureMessage';
import type { TrackerDetection } from '@owlat/shared/postboxTrackers';
import type { PostboxReaderMessage } from '~/components/postbox/PostboxThreadReader.vue';
import { POSTBOX_MARK_READ_DWELL_MS, markReadOnOpen } from '~/utils/postboxMarkReadPolicy';
import { optimisticMarkThreadRead } from '~/lib/mailOptimistic/mailUpdaters';

export type AnswerConversationView = 'summary' | 'full';

const props = defineProps<{
	/** The message being answered: the anchor the thread is read through. */
	message: PostboxReaderMessage;
}>();

const view = defineModel<AnswerConversationView>('view', { default: 'summary' });

const emit = defineEmits<{
	/** The conversation's size, for the top bar ("5 messages"). */
	count: [messageCount: number];
}>();

const { t } = useI18n();
const { isEnabled: isFeatureEnabled } = useFeatureFlag();

const threadKey = () => props.message.threadId ?? props.message._id;
const threadPages = usePostboxThreadPages({ messageId: () => props.message._id, threadKey });
const { data: threadData } = threadPages.newest;
const { hasEarlier, loadingEarlier, earlierFailed, loadEarlier } = threadPages;

const openRow = usePostboxReaderOpenRow({
	message: () => props.message,
	threadMessages: () => threadData.value?.messages,
});

// Newest and unread open; the thread's first message stays a row here.
const { expanded, toggleExpanded } = usePostboxReaderExpansion({
	threadKey,
	activeId: () => props.message._id,
	messages: () => threadPages.newestRows.value,
	startsThread: () => threadPages.startsThread.value,
	expandFirst: false,
});

const threadMessages = usePostboxEnvelopeBodies({
	rows: () => {
		const rows = threadPages.rows.value;
		return rows
			? placeAnchorRow<(typeof rows)[number] | PostboxReaderMessage>(rows, openRow.value)
			: undefined;
	},
	expanded: () => expanded.value,
	bodyIds: () => threadPages.bodyIds.value,
});
const allMessages = computed(() => threadMessages.value ?? [openRow.value]);

const messageCount = computed(() =>
	hasEarlier.value
		? Math.max(threadData.value?.thread?.messageCount ?? 0, allMessages.value.length)
		: allMessages.value.length
);
watch(messageCount, (count) => emit('count', count), { immediate: true });

// "Full" opens everything loaded; back to "summary" restores the default set.
watch(view, (next) => {
	const rows = allMessages.value;
	expanded.value =
		next === 'full'
			? new Set(rows.map((m) => m._id))
			: initialExpandedIds(rows, props.message._id, threadPages.startsThread.value, false);
});

// Answering a conversation reads it: the same mark-read policy the reader
// applies on open (now, after a dwell, or never), since `r` on a list row now
// comes straight here without the reader in between.
const { markReadPolicy } = usePostboxSettings();
const markThreadRead = useBackendOperation(api.mail.messageActions.markThreadRead, {
	label: () => t('components.postbox.postboxThreadReader.markReadOperation'),
	optimisticUpdate: optimisticMarkThreadRead,
});
let markReadTimer: ReturnType<typeof setTimeout> | undefined;
let markedThreadId: string | null = null;
watch(
	() => threadData.value?.thread?._id,
	(threadId) => {
		if (!threadId || threadId === markedThreadId || !threadPages.hasUnread.value) return;
		const mode = markReadOnOpen(markReadPolicy.value);
		if (mode === 'never') return;
		markedThreadId = threadId;
		const run = () =>
			void markThreadRead.run({ threadId: threadId as Id<'mailThreads'>, seen: true });
		if (mode === 'now') run();
		else markReadTimer = setTimeout(run, POSTBOX_MARK_READ_DWELL_MS);
	},
	{ immediate: true }
);
onBeforeUnmount(() => clearTimeout(markReadTimer));

// ── What each card needs (the reader derives the same, per message) ─────────
const mailboxIdRef = computed(() => props.message.mailboxId as Id<'mailboxes'>);
const ownIdentitiesQuery = useConvexQuery(api.mail.identities.listForOwnedMailbox, () => ({
	mailboxId: mailboxIdRef.value,
}));
const ownAddresses = computed(
	() =>
		new Set(
			((ownIdentitiesQuery.data.value as string[] | undefined) ?? []).map(extractEmailAddress)
		)
);
const ownEmail = computed(() => (ownIdentitiesQuery.data.value as string[] | undefined)?.[0]);

function secureClass(msg: PostboxReaderMessage) {
	return classifySecureMessage({ attachments: msg.attachments, textBody: msg.textBodyInline });
}
function hideRawBody(msg: PostboxReaderMessage): boolean {
	const c = secureClass(msg);
	return isEncryptedClass(c) || c === 'pgp-clearsigned';
}
function hasInvite(msg: PostboxReaderMessage): boolean {
	return (msg.attachments ?? []).some(
		(a) =>
			a.contentType.toLowerCase().includes('calendar') || a.filename.toLowerCase().endsWith('.ics')
	);
}

const trackerDetections = ref<Record<string, TrackerDetection>>({});
function trackerFor(msg: { _id: string }): TrackerDetection | null {
	const detection = trackerDetections.value[msg._id];
	return detection && detection.pixelCount > 0 ? detection : null;
}

const relativeTimeNow = useNow({ intervalMs: 60_000 });
function relativeTime(timestamp: number): string {
	void relativeTimeNow.value;
	return formatCompactRelativeTime(timestamp);
}

const { isDark: appIsDark } = useAppTheme();
const { isForcedLight, toggleForcedLight } = usePostboxForcedLight();
const imageAllowlist = usePostboxImageAllowlist(mailboxIdRef);
const {
	downloadingAttachment,
	lightbox,
	handleAttachmentDownload,
	openAttachmentPreview,
	loadLightboxPart,
	downloadLightboxAttachment,
} = usePostboxReaderAttachments();

const senderProfile = ref<{ fromAddress: string; fromName: string | null } | null>(null);
function openSenderProfile(msg: { fromAddress: string; fromName?: string | null }) {
	senderProfile.value = { fromAddress: msg.fromAddress, fromName: msg.fromName ?? null };
}

const showViewToggle = computed(() => allMessages.value.length > 1);
</script>

<template>
	<div class="mx-auto flex max-w-3xl flex-col gap-2 p-4 md:p-6" data-testid="answer-conversation">
		<div v-if="showViewToggle" class="flex justify-end">
			<div
				role="group"
				:aria-label="t('components.answer.mode.viewLabel')"
				class="inline-flex rounded-md border border-border-subtle bg-bg-elevated p-0.5 text-xs"
			>
				<button
					v-for="option in ['summary', 'full'] as const"
					:key="option"
					type="button"
					class="rounded px-2.5 py-1"
					:class="
						view === option
							? 'bg-(--surface-2-selected) text-text-primary'
							: 'text-text-tertiary hover:text-text-primary'
					"
					:aria-pressed="view === option"
					:title="t('components.answer.mode.viewShortcut')"
					:data-testid="`answer-view-${option}`"
					@click="view = option"
				>
					{{ t(`components.answer.mode.view.${option}`) }}
				</button>
			</div>
		</div>

		<!-- The catch-up card (summary, asks) of a thread worth summarising. -->
		<slot name="catch-up" :view="view" :messages="allMessages" />

		<PostboxThreadEarlier
			v-if="hasEarlier || loadingEarlier || earlierFailed"
			:remaining="Math.max(0, messageCount - allMessages.length)"
			:loading="loadingEarlier"
			:failed="earlierFailed"
			@load="loadEarlier"
		/>

		<PostboxReaderMessage
			v-for="msg in allMessages"
			:key="msg._id"
			reduced
			:message="msg"
			:mailbox-id="message.mailboxId"
			:expanded="expanded.has(msg._id)"
			:relative-time="relativeTime(msg.receivedAt)"
			:starred="false"
			:show-reply-all="false"
			:show-sender-controls="!ownAddresses.has(extractEmailAddress(msg.fromAddress))"
			:auth-enabled="isFeatureEnabled('senderAuthBadges')"
			:sealed-enabled="isFeatureEnabled('sealedMail')"
			:secure-class="secureClass(msg)"
			:hide-body="hideRawBody(msg)"
			:tracker="trackerFor(msg)"
			:scheduling-times="null"
			:show-render-toggle="appIsDark"
			:forced-light="isForcedLight(msg._id)"
			:images-allowed="imageAllowlist.isAllowed(msg.fromAddress)"
			:own-email="ownEmail"
			:has-invite="hasInvite(msg)"
			:downloading-attachment="downloadingAttachment"
			@toggle-expanded="toggleExpanded(msg._id)"
			@open-sender-profile="openSenderProfile(msg)"
			@toggle-forced-light="toggleForcedLight(msg._id)"
			@preview-attachment="(att, all) => openAttachmentPreview(msg._id, att, all)"
			@download-attachment="(att) => handleAttachmentDownload(msg._id, att)"
			@trackers="trackerDetections[msg._id] = $event"
			@trust-sender="imageAllowlist.allow($event)"
			@untrust-sender="imageAllowlist.revoke($event)"
		/>

		<PostboxSenderProfile
			v-if="senderProfile"
			:open="true"
			:mailbox-id="message.mailboxId"
			:from-address="senderProfile.fromAddress"
			:from-name="senderProfile.fromName"
			@update:open="(open: boolean) => !open && (senderProfile = null)"
		/>
		<PostboxAttachmentLightbox
			v-if="lightbox"
			:attachments="lightbox.attachments"
			:initial-index="lightbox.index"
			:load-part="loadLightboxPart"
			@close="lightbox = null"
			@download="downloadLightboxAttachment"
		/>
	</div>
</template>
