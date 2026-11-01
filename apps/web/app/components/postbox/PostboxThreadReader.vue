<script lang="ts">
/**
 * The full message row the reader renders, re-exported for hosts that pass rows
 * through — the folder view, the search preview, and the Today view's centered
 * overlay.
 */
export type { PostboxReaderMessage } from '~/composables/postbox/postboxReaderMessage';
</script>

<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { extractEmailAddress } from '~/utils/emailAddress';
import { postboxBodyImageProps } from '~/utils/postboxImageAllowlist';
import { postboxFilterQueryFrom } from '~/utils/postboxFilterFromMessage';
import { usePostboxReaderBrief } from '~/composables/postbox/usePostboxReaderBrief';
import { usePostboxCalmReader } from '~/composables/postbox/usePostboxCalmReader';
import { providePostboxReaderContext } from '~/composables/postbox/usePostboxReaderContext';
import { usePostboxListQuery } from '~/composables/postbox/usePostboxPlacementFilter';
import { usePostboxMountAllBodies } from '~/composables/postbox/usePostboxLazyBody';
import type { PostboxReaderMessage } from '~/composables/postbox/postboxReaderMessage';
import { usePostboxReaderConversation } from '~/composables/postbox/usePostboxReaderConversation';
import { usePostboxReaderMessageFacts } from '~/composables/postbox/usePostboxReaderMessageFacts';
import { usePostboxReaderMarkRead } from '~/composables/postbox/usePostboxReaderMarkRead';
import {
	usePostboxReaderReplies,
	type PostboxReplyGuardHandle,
} from '~/composables/postbox/usePostboxReaderReplies';
import { usePostboxReaderTeam } from '~/composables/postbox/usePostboxReaderTeam';
import { usePostboxReaderCorrespondent } from '~/composables/postbox/usePostboxReaderCorrespondent';
import { usePostboxReaderCommands } from '~/composables/postbox/usePostboxReaderCommands';
import { vReplyDrop } from '~/composables/useReplyFileDrop';
import type { PostboxFindSeed } from '~/composables/postbox/usePostboxThreadFind';

const props = defineProps<{
	message: PostboxReaderMessage;
	// Auto-advance (folder view only): `advanceIds` is the list's visual order,
	// `folderRole` the route segment for /dashboard/postbox/<folder>/<id> links.
	advanceIds?: string[];
	folderRole?: string;
	// Overlay hosting (Today's centered reader): auto-advance swaps the reader in
	// place via `advance`, so triaging never tears down the overlay.
	advanceInPlace?: boolean;
	/** Opened from a search result: find opens on its words, that message first. */
	findSeed?: PostboxFindSeed | null;
}>();

const emit = defineEmits<{
	/** advance-in-place hosts: open this message next (null = back to the list). */
	advance: [messageId: string | null];
}>();

const listQuery = usePostboxListQuery();

const { isEnabled: isFeatureEnabled } = useFeatureFlag();

// The conversation in pages, the opened row until it answers, what is expanded,
// the thread's own fields and the mailbox's own addresses.
const conversation = usePostboxReaderConversation(() => props.message);
const {
	ownAddresses,
	ownEmail,
	messageId,
	threadKey,
	threadPages,
	threadData,
	isLoading,
	expanded,
	toggleExpanded,
	allMessages,
	threadMessageCount,
	latestMessage,
	readerThread,
	latestOutboundId,
	labelMap,
	threadLabels,
} = conversation;
const { hasEarlier, loadingEarlier, earlierFailed, loadEarlier } = threadPages;

const mailboxIdRef = computed(() => props.message.mailboxId as Id<'mailboxes'>);

// Per message: PGP/S-MIME structure, trackers, invite, delivery, scheduling chip,
// and how its card renders (relative time, forced light, remote images).
const facts = usePostboxReaderMessageFacts({
	messageId,
	mailboxId: mailboxIdRef,
	messages: allMessages,
	thread: () => threadData.value?.thread,
	aiEnabled: () => isFeatureEnabled('ai'),
});

// Plan idea 45: one sender profile slide-over for the whole reader; the opened
// sender travels in state instead of mounting a panel per message.
const senderProfile = ref<{ fromAddress: string; fromName: string | null } | null>(null);
function openSenderProfile(msg: { fromAddress: string; fromName?: string | null }) {
	senderProfile.value = { fromAddress: msg.fromAddress, fromName: msg.fromName ?? null };
}

// The thread brief (personal mailboxes): the strip, cites, latest lines, reactions.
// Per-user reader preferences (auto-advance, reply default, mark-read policy, the
// brief), read before the brief and the mark-read watcher, which both run immediately.
const { autoAdvance, replyDefault, markReadPolicy, autoSummarize, autoLoadImages } =
	usePostboxSettings();

const rb = usePostboxReaderBrief({
	mailboxId: () => props.message.mailboxId,
	threadId: () => readerThread.value?._id ?? props.message.threadId,
	messages: allMessages,
	expanded,
	toggleExpanded,
	pages: threadPages,
	secureClass: facts.secureClass,
	isOwnAddress: (address) => ownAddresses.value.has(extractEmailAddress(address)),
	onReply: () => readerActions.runReaderAction('reply'),
	showBrief: () => autoSummarize.value,
});

// Mark-as-read on open (under markReadPolicy) and the back-from-snooze cue.
const { markThreadReadOp, showsManualMarkReadButton, markOpenThreadRead } =
	usePostboxReaderMarkRead({
		messageId: () => props.message._id,
		threadData: () => threadData.value,
		hasUnread: threadPages.hasUnread,
		policy: markReadPolicy,
	});

// Expanded bodies mount as they near the viewport; printing mounts them all.
const articleEl = ref<HTMLElement | null>(null);
const { mountAll: mountAllBodies, preparePrint } = usePostboxMountAllBodies({
	threadKey: () => props.message.threadId ?? props.message._id,
	root: articleEl,
});

// Adaptive dark rendering: whether the app is dark, for every card's body.
const { isDark: appIsDark } = useAppTheme();

// Sender-authentication badge (Sealed Mail A3, flag `senderAuthBadges`). The
// derivation is honest — absent verdicts yield no badge — so this is safe to
// compute for every message; the flag only decides whether it renders.
const authBadgesEnabled = computed(() => isFeatureEnabled('senderAuthBadges'));

// Sealed-Mail reader badge (E5, flag `sealedMail`). Gates the honest "Sealed —
// sender verified / not verified" / "can't decrypt" chip driven by the inbound
// sealing record. When off, sealed messages fall back to the structural badge.
const sealedMailEnabled = computed(() => isFeatureEnabled('sealedMail'));

// Reply / reply-all / forward open Answer mode; every reply and reply-all goes
// through the one-time-per-thread confirm on a sender in a flagged shape.
const replyGuardEl = ref<PostboxReplyGuardHandle | null>(null);
const replies = usePostboxReaderReplies({
	message: () => props.message,
	folderRole: () => props.folderRole,
	messages: allMessages,
	latestMessage,
	ownAddresses,
	replyDefault,
	guardEl: replyGuardEl,
	guardEnabled: authBadgesEnabled,
});
const { replyDrop } = replies;

// The thread's correspondent (Sealed Mail 1:1 plane) and their sealing-key status.
const {
	threadCounterpart,
	correspondentKey,
	correspondentKeyWasVerified,
	correspondentKeyChanged,
	refetchCorrespondentKey,
	sealStatusFor,
} = usePostboxReaderCorrespondent({ messages: allMessages, ownAddresses, sealedMailEnabled });

// The team discussion panel, or for a shared mailbox the team stream.
const { discussionThreadId, discussionArticleClass, discussionCounterparty, team } =
	usePostboxReaderTeam({
		message: () => props.message,
		readerThread,
		messages: allMessages,
		latestMessage,
		ownAddresses,
		isShared: () => rb.isShared.value,
		guardLatestReply: replies.guardLatestReply,
		replyWithBody: replies.openReplyWithBody,
		reply: () => readerActions.runReaderAction('reply'),
	});

// The calm reader's chrome (read on arrival §3): one notice, Details, the
// Full brief sheet, Ask, and the "Why here?" seam lane learn fills.
const stripEl = ref<{ detailsEl: HTMLElement | null } | null>(null);
const calm = usePostboxCalmReader({
	threadKey,
	mailboxId: () => props.message.mailboxId,
	threadId: () => discussionThreadId.value,
	// The projection already applies the thread's override (except an older
	// one an exact-wording candidate overrules); the override alone covers a
	// thread without one.
	placement: () =>
		readerThread.value?.arrival?.placement ?? readerThread.value?.placementOverride?.placement,
	messages: allMessages,
	latest: latestMessage,
	expanded,
	keyChanged: computed(() => !!correspondentKeyChanged.value),
	isSigned: rb.isSigned,
	detailsEl: computed(() => stripEl.value?.detailsEl ?? null),
});

// Thread-level triage of the OPEN message (archive / trash / star / snooze /
// mute / pin / label / move / spam / block), the auto-advance that follows it and
// the pickers it opens. Reply / reply-all / forward route back through the
// composer layer above so they stay behind the sender-auth reply guard.
const readerActions = usePostboxReaderActions({
	getMessage: () => props.message,
	messageId,
	mailboxId: mailboxIdRef,
	allMessages,
	readerThread,
	autoAdvance,
	beforePrint: preparePrint,
	advance: {
		ids: () => props.advanceIds,
		folderRole: () => props.folderRole,
		inPlace: () => props.advanceInPlace,
		emit: (target) => emit('advance', target),
		// A filtered list (`?placement=`) keeps its filter as the reader moves on.
		query: () => listQuery.value,
	},
	compose: {
		reply: replies.replyToLatest,
		replyAll: replies.replyAllToLatest,
		forward: replies.forwardLatest,
	},
});
// Translate, Copy link / Share in chat, Find (⌘F), the ⌘K surface and the
// single-key shortcuts, all acting on this conversation.
const { translation, find, shareTarget, copyConversationLink, conversationLinkOf } =
	usePostboxReaderCommands({
		message: () => props.message,
		folderRole: () => props.folderRole,
		findSeed: () => props.findSeed,
		threadKey,
		pages: threadPages,
		messages: allMessages,
		latestMessage,
		ownAddresses,
		readerThread,
		latestOutboundId,
		expanded,
		toggleExpanded,
		secureClass: facts.secureClass,
		hideRawBody: facts.hideRawBody,
		aiEnabled: () => isFeatureEnabled('ai'),
		actions: readerActions,
	});

// Attachment download plus the Quick Look overlay for image/PDF parts.
const attachments = usePostboxReaderAttachments();
const { downloadingAttachment, handleAttachmentDownload, openAttachmentPreview } = attachments;

// What every card shares; the props carry only what differs per message.
providePostboxReaderContext({
	mailboxId: () => props.message.mailboxId,
	authEnabled: authBadgesEnabled,
	sealedEnabled: sealedMailEnabled,
	appIsDark,
	ownEmail,
	downloadingAttachment,
	eagerBody: mountAllBodies,
	reduced: false,
	chromeOf: calm.cardOf,
	// A selected passage replies to the message it is from, behind the guard.
	quoteReply: {
		canQuote: (messageId) => allMessages.value.some((m) => m._id === messageId),
		quote: (messageId, passage) => {
			const msg = allMessages.value.find((m) => m._id === messageId);
			if (msg) replies.runGuarded(msg, () => void replies.openQuoteReply(msg, passage));
		},
	},
	find,
});

/** Open the filter builder pre-filled from this message (see postboxFilterQueryFrom). */
function createFilterFrom(msg: { fromAddress?: string; subject?: string }) {
	const query = postboxFilterQueryFrom(msg);
	if (query) void navigateTo({ path: '/dashboard/preferences/filters', query });
}
</script>

<template>
	<article
		ref="articleEl"
		v-reply-drop="replyDrop"
		class="pbx-reader-article p-6 max-w-4xl mx-auto"
		:class="team.isActive.value ? '' : discussionArticleClass"
	>
		<!-- One page (read on arrival §3): header line, the strip (or the slim
		     "Why here? · Details" line), one notice, then the conversation. -->
		<PostboxThreadHeader
			:subject="message.subject"
			:message-count="threadMessageCount"
			:message-id="messageId"
			:thread="readerThread"
			:show-mark-read="showsManualMarkReadButton"
			:marking-read="markThreadReadOp.isLoading.value"
			:show-why-here="!rb.isShared.value"
			:show-ask="isFeatureEnabled('ai')"
			:show-full-brief="rb.hasFullBrief.value"
			@toggle-mute="readerActions.toggleOpenThreadMute"
			@toggle-alert="readerActions.toggleOpenThreadAlert"
			@toggle-pin="readerActions.toggleOpenThreadPin"
			@mark-read="markOpenThreadRead"
			@reply="readerActions.runReaderAction('reply')"
			@archive="readerActions.runReaderAction('archive')"
			@snooze="readerActions.runReaderAction('snooze')"
			@ask="calm.asking.value = !calm.asking.value"
			@details="calm.detailsOpen.value = true"
			@full-brief="calm.sheetOpen.value = true"
			@why-here="calm.openWhyHere"
		>
			<template #actions>
				<PostboxThreadFindButton @click="find.open()" />
				<PostboxThreadDiscussionToggle
					v-if="discussionThreadId && !team.isActive.value"
					:thread-id="discussionThreadId"
				/>
			</template>
		</PostboxThreadHeader>
		<PostboxThreadFindBar :find="find" />

		<PostboxReaderStrip
			ref="stripEl"
			v-model:details-open="calm.detailsOpen.value"
			:strip="rb.strip.value"
			:gist-attribution="rb.gistAttribution.value"
			:summary="calm.summary.value"
			:show-why-here="!rb.isShared.value"
			:has-exact-wording="!!rb.firstExactWordingId.value"
			:has-full-brief="rb.hasFullBrief.value && rb.isBriefShown.value"
			@why-here="calm.openWhyHere"
			@full-brief="calm.sheetOpen.value = true"
			@exact-wording="rb.citeMessage(rb.firstExactWordingId.value ?? '')"
			@react="rb.react"
		>
			<template #details>
				<PostboxReaderDetails
					:message-id="messageId"
					:thread="readerThread"
					:latest-outbound-id="latestOutboundId"
					:label-ids="threadLabels"
					:labels="labelMap"
				/>
			</template>
		</PostboxReaderStrip>

		<PostboxReaderNotice
			:kind="calm.notice.value"
			:danger="calm.danger.value"
			:danger-text="calm.dangerText.value"
		>
			<!-- Sealed Mail (E5): the Signal-style key-change banner (explicit re-pin). -->
			<template #keyChange>
				<PostboxKeyChangeBanner
					:address="threadCounterpart"
					:old-fingerprint="correspondentKey?.pinnedFingerprint"
					:new-fingerprint="correspondentKey?.observedFingerprint"
					:was-verified="correspondentKeyWasVerified"
					@accepted="refetchCorrespondentKey()"
				/>
			</template>
		</PostboxReaderNotice>

		<PostboxAiStrip
			v-if="calm.asking.value && latestMessage"
			class="mb-3"
			:message-id="latestMessage._id"
			@close="calm.asking.value = false"
		/>
		<PostboxReaderTranslation
			v-if="translation.state.value.status !== 'idle'"
			class="mb-3"
			:state="translation.state.value"
			:language="translation.targetLanguage.value"
			@close="translation.close"
			@retry="translation.translate"
		/>

		<!-- No skeleton while the thread loads: the opened row renders with its
		     inline body, and the rest of the conversation joins it on arrival. -->
		<div class="space-y-2">
			<PostboxThreadCiteNote :state="rb" />

			<TeamPinnedItems
				v-if="team.isActive.value"
				class="mb-3"
				:team="team.team"
				:cite-message="rb.citeMessage"
				:cite-unreachable="rb.messageCiteState.value === 'unreachable'"
			/>
			<PostboxThreadEarlier
				v-if="hasEarlier || loadingEarlier || earlierFailed"
				:remaining="Math.max(0, threadMessageCount - allMessages.length)"
				:loading="loadingEarlier"
				:failed="earlierFailed"
				@load="loadEarlier"
			/>
			<PostboxTeamInterlude :state="team" :entries="team.leading.value" leading />

			<template v-for="msg in allMessages" :key="msg._id">
				<PostboxReaderMessage
					:message="msg"
					:expanded="expanded.has(msg._id)"
					:relative-time="facts.relativeReceivedAt(msg.receivedAt)"
					:starred="readerActions.isMessageStarred(msg)"
					:show-reply-all="replies.hasOtherRecipients(msg)"
					:show-sender-controls="!ownAddresses.has(extractEmailAddress(msg.fromAddress))"
					:secure-class="facts.secureClass(msg)"
					:hide-body="facts.hideRawBody(msg)"
					:tracker="facts.trackerDetection(msg)"
					:delivery="facts.deliveryFor(msg)"
					:scheduling-times="facts.schedulingTimesFor(msg)"
					:forced-light="facts.isForcedLight(msg._id)"
					:images="
						postboxBodyImageProps(msg, {
							autoLoadImages,
							isSenderAllowed: facts.imageAllowlist.isAllowed(msg.fromAddress),
						})
					"
					:has-invite="!!facts.calendarAttachment(msg)"
					:seal-status="sealStatusFor(msg)"
					:latest-line="rb.latestFor(msg._id)"
					:cite-quote="rb.citeQuoteFor(msg._id)"
					@image-state="calm.onImageState(msg._id, $event)"
					@toggle-expanded="toggleExpanded(msg._id)"
					@open-sender-profile="openSenderProfile(msg)"
					@toggle-forced-light="facts.toggleForcedLight(msg._id)"
					@toggle-star="readerActions.toggleMessageStar(msg)"
					@reply="replies.guardedReply(msg)"
					@reply-all="replies.guardedReplyAll(msg)"
					@forward="replies.openForward(msg)"
					@report-spam="readerActions.reportSpamMessage(msg._id)"
					@block-sender="readerActions.blockSenderOf(msg._id)"
					@create-filter="createFilterFrom(msg)"
					@print="readerActions.runReaderAction('print')"
					@copy-link="copyConversationLink(conversationLinkOf(msg._id))"
					@share-in-chat="shareTarget = conversationLinkOf(msg._id)"
					@preview-attachment="(att, all) => openAttachmentPreview(msg._id, att, all)"
					@download-attachment="(att) => handleAttachmentDownload(msg._id, att)"
					@trackers="facts.onTrackersDetected(msg._id, $event)"
					@trust-sender="facts.imageAllowlist.allow($event)"
					@untrust-sender="facts.imageAllowlist.revoke($event)"
					@resend="(addresses) => replies.openResend(msg, addresses)"
					@use-reply="(text) => replies.openReplyWithBody(msg, text)"
					@dismiss-scheduling="facts.dismissScheduling(msg._id)"
					@seal-refetch="refetchCorrespondentKey()"
				/>
				<PostboxTeamInterlude :state="team" :entries="team.after(msg._id)" />
			</template>

			<!-- "You archive everything from this sender. Always archive it?"
			     (idea 27). Foot of the reader, under the conversation: it is an
			     observation about the SENDER, not about this message. Strictly an
			     offer — it renders nothing until a sender's tally earns one, and
			     nothing is ever applied without the explicit click. -->
			<PostboxTriageSuggestion v-if="latestMessage && !isLoading" :message-id="latestMessage._id" />
		</div>

		<PostboxTeamComposer
			v-if="team.isActive.value && discussionThreadId"
			:state="team"
			:thread-id="discussionThreadId"
			:counterparty="discussionCounterparty"
		/>
		<PostboxThreadDiscussion
			v-else-if="discussionThreadId"
			:thread-id="discussionThreadId"
			:mailbox-id="message.mailboxId"
			:counterparty-label="discussionCounterparty"
		/>

		<!-- One-time-per-thread confirm before replying to a message that failed
		     sender authentication (flag `senderAuthBadges`). -->
		<PostboxReplyGuard ref="replyGuardEl" />

		<!-- The pickers, the full brief, the sender profile, share in chat, Quick Look. -->
		<PostboxThreadReaderOverlays
			v-model:brief-open="calm.sheetOpen.value"
			v-model:sender-profile="senderProfile"
			v-model:share-target="shareTarget"
			:mailbox-id="message.mailboxId"
			:actions="readerActions"
			:brief="rb"
			:messages="allMessages"
			:shared="rb.isShared.value"
			:attachments="attachments"
		/>
	</article>
</template>
