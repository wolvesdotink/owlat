<script lang="ts">
import type { SenderHeuristics } from '~/utils/senderAuth';
import type { InboundEncryptionInfo } from '~/utils/sealedMessage';
import type { InboundSignatureInfo } from '~/utils/signatureBadge';

/**
 * The full message row the reader renders (the list-row shape plus body /
 * verdict fields). Exported for hosts that pass rows through — the folder
 * view, the search preview, and the Today view's centered overlay.
 */
export type PostboxReaderMessage = {
	_id: string;
	mailboxId: string;
	threadId?: string;
	fromAddress: string;
	fromName?: string;
	toAddresses: string[];
	ccAddresses: string[];
	subject: string;
	snippet?: string;
	receivedAt: number;
	htmlBodyInline?: string;
	textBodyInline?: string;
	hasAttachments: boolean;
	attachments: Array<{
		filename: string;
		contentType: string;
		size: number;
		partIndex?: string;
		contentId?: string;
	}>;
	spamVerdict?: string;
	// Inbound sender-authentication verdicts + DMARC alignment inputs, persisted
	// at ingest (Sealed Mail A1) and threaded through the reader queries here so
	// A3 can render an honest sender badge. All optional: a message delivered by
	// an older MTA (or a legacy row from before A1) carries them absent, and the
	// reader must surface that as "unknown" rather than assert a verdict we never
	// computed.
	spfResult?: string;
	dkimResult?: string;
	dmarcResult?: string;
	dmarcPolicy?: string;
	envelopeFromDomain?: string;
	dkimSigningDomain?: string;
	// Inbound-auth override the backend applied (Sealed Mail A5): `'arc'` when a
	// trusted forwarder's validated ARC chain rescued a DMARC fail; `arcSealer`
	// names the honoured sealer so the badge can render "verified via forwarder".
	dmarcOverride?: string;
	arcSealer?: string;
	// Ingest-computed sender-impersonation heuristics (Sealed Mail A4), threaded
	// through so the sender badge can render secondary detail lines (first-time
	// sender, look-alike of a known contact's domain). Whole object absent when
	// nothing fired — the badge shows no extra lines rather than a false "clear".
	senderHeuristics?: SenderHeuristics;
	// Sealed Mail (E5): the honest inbound sealing record from decrypt-on-ingest
	// (D3, `mailMessages.inboundEncryptionInfo`). Present only on a message that
	// arrived sealed between Owlat instances; absent for ordinary mail, where the
	// structural PGP/S-MIME badge (`secureClass`) takes over. Drives the reader's
	// "Sealed — sender verified / not verified" / "can't decrypt" badge.
	inboundEncryptionInfo?: InboundEncryptionInfo;
	// F2 (D9): the honest inbound signature verdict for PGP-signed (unencrypted)
	// mail, verified server-side at ingest (F1, `mailMessages.inboundSignatureInfo`).
	// Absent for plaintext mail and pre-F1 rows, where the structural badge's
	// "not verified" fallback takes over. Sealed record precedence is owned by
	// the badge's drivers, not here.
	inboundSignatureInfo?: InboundSignatureInfo;
	flagSeen?: boolean;
	unsubscribe?: { httpUrl?: string; mailtoUrl?: string; oneClick: boolean };
};
</script>

<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { extractAttachmentAt } from '@owlat/shared/mailMime';
import { extractEmailAddress } from '~/utils/emailAddress';
import { deriveReplyRisk, senderRiskInputOf, type ReplyRisk } from '~/utils/senderAuth';
import { formatCompactRelativeTime } from '~/utils/formatters';
import { isLongThreadForSummary } from '~/utils/postboxAutoSummary';
import {
	POSTBOX_MARK_READ_DWELL_MS,
	markReadOnOpen,
	showsManualMarkRead,
} from '~/utils/postboxMarkReadPolicy';
import type { PostboxSnoozeScope } from '~/utils/postboxSnoozeScope';
import { shouldShowSchedulingChip } from '~/utils/postboxSchedulingChip';
import {
	classifySecureMessage,
	isEncryptedClass,
	type SecureMessageClass,
} from '@owlat/shared/secureMessage';
import type { TrackerDetection } from '@owlat/shared/postboxTrackers';
import type { OutboundDelivery } from '~/utils/postboxDeliveryStrip';

const props = defineProps<{
	message: PostboxReaderMessage;
	// Auto-advance context (folder view only; the search preview passes
	// neither and keeps its stay-put behavior). `advanceIds` is the list's
	// current visual order (optimistic-hide filtered), `folderRole` the
	// route segment used to build /dashboard/postbox/<folder>/<id> links.
	advanceIds?: string[];
	folderRole?: string;
	// Overlay hosting (the Today view's centered reader): auto-advance swaps
	// the reader IN PLACE via the `advance` emit instead of navigating to the
	// folder/message route, so triaging never tears down the overlay.
	advanceInPlace?: boolean;
}>();

const emit = defineEmits<{
	/** advance-in-place hosts: open this message next (null = back to the list). */
	advance: [messageId: string | null];
}>();

const { t } = useI18n();
const { showToast } = useToast();
const { showOperationError } = useOperationErrorToast();

const { isEnabled: isFeatureEnabled } = useFeatureFlag();

// The mailbox's own addresses (canonical + active aliases) — excluded from the
// Cc set on Reply-All so the user never adds themselves.
const ownIdentitiesQuery = useConvexQuery(api.mail.identities.listForOwnedMailbox, () => ({
	mailboxId: props.message.mailboxId as Id<'mailboxes'>,
}));

const ownAddresses = computed(
	() =>
		new Set(
			((ownIdentitiesQuery.data.value as string[] | undefined) ?? []).map(extractEmailAddress)
		)
);
const ownEmail = computed(() => (ownIdentitiesQuery.data.value as string[] | undefined)?.[0]);

// PGP/S-MIME structure per message (detection only — see PostboxSecurityBadge),
// classified once per thread change rather than on every template re-render.
const secureClassMap = computed(() => {
	const map = new Map<string, SecureMessageClass>();
	for (const m of allMessages.value) {
		map.set(
			m._id,
			classifySecureMessage({ attachments: m.attachments, textBody: m.textBodyInline })
		);
	}
	return map;
});
function secureClass(msg: { _id: string }): SecureMessageClass {
	return secureClassMap.value.get(msg._id) ?? 'none';
}
/** Hide the raw body when it's encrypted (gibberish) or clearsigned (the badge
 * shows the readable cleartext instead). */
function hideRawBody(msg: { _id: string }): boolean {
	const c = secureClass(msg);
	return isEncryptedClass(c) || c === 'pgp-clearsigned';
}

// Tracking-pixel detections reported by each message body (fail-soft: a
// message with no report simply shows no badge).
const trackerDetections = ref<Record<string, TrackerDetection>>({});
function onTrackersDetected(msgId: string, detection: TrackerDetection) {
	trackerDetections.value[msgId] = detection;
}
function trackerDetection(msg: { _id: string }): TrackerDetection | null {
	const detection = trackerDetections.value[msg._id];
	return detection && detection.pixelCount > 0 ? detection : null;
}

/** The text/calendar (.ics) attachment of a message, if it carries an invite. */
function calendarAttachment(msg: {
	attachments: Array<{ filename: string; contentType: string; partIndex?: string }>;
}) {
	return msg.attachments?.find(
		(a) =>
			a.contentType.toLowerCase().includes('calendar') || a.filename.toLowerCase().endsWith('.ics')
	);
}

// Plan idea 45: the sender profile slide-over. One instance for the whole
// reader — a thread with twenty collapsed messages must not mount (and
// subscribe) twenty panels, so the opened sender travels in state instead.
const senderProfile = ref<{ fromAddress: string; fromName: string | null } | null>(null);
function openSenderProfile(msg: { fromAddress: string; fromName?: string | null }) {
	senderProfile.value = { fromAddress: msg.fromAddress, fromName: msg.fromName ?? null };
}

const messageId = computed(() => props.message._id as Id<'mailMessages'>);
const { data: threadData, isLoading } = useConvexQuery(
	api.mail.mailbox.messages.listThreadMessages,
	() => ({
		messageId: messageId.value,
	})
);

const allMessages = computed(() => threadData.value?.messages ?? [props.message]);
const latestMessage = computed(() => allMessages.value[allMessages.value.length - 1]);

// The one reader AI strip (PostboxAiStrip) mounts whenever AI is on and the
// thread has a latest message; it hosts the summary gist, Ask, and Draft reply.
// `warrantsSummary` decides whether it eagerly generates a summary: long thread
// (>= 5 messages OR a lot of body text) AND the per-user auto-summary toggle
// (default ON). When false and nothing is cached, the strip collapses to zero
// height — so a short thread shows no AI element at all.
const { autoSummarize } = usePostboxSettings();
const warrantsSummary = computed(
	() => autoSummarize.value && isLongThreadForSummary(allMessages.value)
);
const showAiStrip = computed(() => isFeatureEnabled('ai') && !!latestMessage.value);

// Follow-up ("remind me if no reply") chip: armable only while the thread
// ends on our own sent message — an inbound reply on top means they already
// answered (and clears any armed watch server-side anyway).
const readerThread = computed(
	() =>
		threadData.value?.thread as
			| {
					_id: string;
					followUp?: {
						messageId: string;
						remindAt: number;
						dueAt?: number;
						waitingOn?: string;
					};
					// Muted conversation, its opt-in twin (alert me when they reply)
					// and the transient back-from-snooze marker — all checkable states
					// in the thread ⋯ menu (mail/mute.ts, mail/threadAlerts.ts,
					// mail/snooze.ts).
					mutedAt?: number;
					notifyOnReplyAt?: number;
					snoozeReturnedAt?: number;
			  }
			| null
			| undefined
);
const latestOutboundId = computed(() => {
	const last = allMessages.value[allMessages.value.length - 1] as
		| { _id: string; outbound?: unknown }
		| undefined;
	return last && last.outbound !== undefined ? last._id : undefined;
});
// Per-recipient delivery evidence for the messages WE sent in this thread (plan
// idea 1). One subscription for the whole conversation rather than one per
// message; an inbound-only thread gets an empty array and renders no strip.
const { data: outboundDelivery } = useConvexQuery(
	api.mail.mailbox.messages.listThreadOutboundDelivery,
	() => ({ messageId: messageId.value })
);
const deliveryByMessage = computed(() => {
	const map = new Map<string, OutboundDelivery>();
	for (const row of outboundDelivery.value ?? []) {
		map.set(row.messageId, { state: row.state, recipients: row.recipients });
	}
	return map;
});
function deliveryFor(msg: { _id: string }): OutboundDelivery | null {
	return deliveryByMessage.value.get(msg._id) ?? null;
}

const labelMap = computed(() => {
	const map = new Map<string, { _id: string; name: string; color?: string }>();
	for (const l of threadData.value?.labels ?? []) map.set(l._id, l);
	return map;
});
const threadLabels = computed(() => threadData.value?.thread?.labelIds ?? []);

// Plain-prose scheduling request ("can we meet Tuesday afternoon?") detected by
// the needs-reply refinement pass and stashed on the thread. Drives the quiet
// "draft a reply?" chip under the triggering message's header. Server already
// excludes messages that carry a real .ics invite; the reader guards again so
// the chip never coexists with the PostboxInviteCard. Dismissible per message
// for the session.
const schedulingIntent = computed(() => {
	const needsReply = (
		threadData.value?.thread as
			| {
					needsReply?: {
						messageId?: string;
						meetingIntent?: {
							isScheduling: boolean;
							proposedTimes: string[];
							topic?: string;
						};
					};
			  }
			| null
			| undefined
	)?.needsReply;
	if (!needsReply?.meetingIntent?.isScheduling) return null;
	return {
		messageId: needsReply.messageId,
		proposedTimes: needsReply.meetingIntent.proposedTimes ?? [],
	};
});

const dismissedScheduling = ref(new Set<string>());
function dismissScheduling(messageId: string) {
	dismissedScheduling.value = new Set(dismissedScheduling.value).add(messageId);
}
/**
 * The proposed times to offer under `msg`, or null when this message gets no
 * scheduling chip at all (no intent, wrong message, dismissed, AI off, or a real
 * .ics invite is attached — PostboxInviteCard owns that case).
 */
function schedulingTimesFor(msg: {
	_id: string;
	attachments: Array<{ filename: string; contentType: string; partIndex?: string }>;
}): string[] | null {
	const intent = schedulingIntent.value;
	const show = shouldShowSchedulingChip({
		aiEnabled: isFeatureEnabled('ai'),
		meetingIntent: intent ? { isScheduling: true, proposedTimes: intent.proposedTimes } : null,
		triggerMessageId: intent?.messageId,
		message: msg,
		dismissed: dismissedScheduling.value,
	});
	return show ? (intent?.proposedTimes ?? []) : null;
}

// Per-user reader preferences: auto-advance after triaging the open message
// away (archive / trash / snooze / spam — active only in the folder view, the
// search preview stays put), the primary reply mode, and when an opened
// conversation is marked read. Read here rather than beside their consumers
// because the mark-read watcher below runs immediately.
const { autoAdvance, replyDefault, markReadPolicy } = usePostboxSettings();

// Mark-as-read on open (Gmail conversation-view semantics), under the user's
// markReadPolicy: 'immediate' clears the unread flags on render (the behaviour
// the reader always had, and what an unset preference resolves to),
// 'after-dwell' waits POSTBOX_MARK_READ_DWELL_MS of visible dwell and cancels
// if the reader is navigated away or torn down first, and 'manual' never fires
// — the thread ⋯ menu offers an explicit item instead.
//
// Guarded per thread so the reactive re-fetch that follows (flagSeen flips →
// query re-runs) doesn't re-fire, and so a dwell timer is armed at most once.
const markThreadReadOp = useBackendOperation(api.mail.messageActions.markThreadRead, {
	label: () => t('components.postbox.postboxThreadReader.markReadOperation'),
});
const markedThreads = new Set<string>();
let dwellTimer: ReturnType<typeof setTimeout> | undefined;

function cancelDwell() {
	if (dwellTimer !== undefined) {
		clearTimeout(dwellTimer);
		dwellTimer = undefined;
	}
}

function runMarkThreadRead(threadId: string) {
	void markThreadReadOp.run({ threadId: threadId as Id<'mailThreads'>, seen: true });
}

/** True while the open thread still has an unread message (drives the button). */
const threadHasUnread = computed(() => (threadData.value?.messages ?? []).some((m) => !m.flagSeen));
const showsManualMarkReadButton = computed(() =>
	showsManualMarkRead(markReadPolicy.value, threadHasUnread.value)
);

/** The thread menu's explicit "Mark read" item (markReadPolicy 'manual'). */
function markOpenThreadRead() {
	const threadId = threadData.value?.thread?._id;
	if (!threadId) return;
	markedThreads.add(threadId);
	runMarkThreadRead(threadId);
}

watch(
	() => threadData.value,
	(data) => {
		const thread = data?.thread;
		if (!thread) return;
		if (markedThreads.has(thread._id)) return;
		if (!(data?.messages ?? []).some((m) => !m.flagSeen)) return;
		const mode = markReadOnOpen(markReadPolicy.value);
		if (mode === 'never') return;
		markedThreads.add(thread._id);
		if (mode === 'now') {
			runMarkThreadRead(thread._id);
			return;
		}
		// 'after-dwell': a j/k skim past a row or a mis-click never burns the
		// unread flag, because leaving the reader clears the timer.
		cancelDwell();
		const threadId = thread._id;
		dwellTimer = setTimeout(() => {
			dwellTimer = undefined;
			runMarkThreadRead(threadId);
		}, POSTBOX_MARK_READ_DWELL_MS);
	},
	{ immediate: true }
);
// Navigating to another conversation (or unmounting) cancels a pending dwell,
// and re-arms for the newly opened thread through the watcher above.
watch(
	() => props.message._id,
	() => cancelDwell()
);
onBeforeUnmount(cancelDwell);

// Back-from-snooze marker (mail/snooze.ts): a one-shot recognition cue, so
// opening the thread is what dismisses it. Fired once per thread per mount;
// the mutation is idempotent server-side.
const clearSnoozeReturnedOp = useBackendOperation(api.mail.snooze.clearSnoozeReturned, {
	label: () => t('components.postbox.postboxThreadReader.clearSnoozeReturnedOperation'),
});
const clearedSnoozeReturned = new Set<string>();
watch(
	() => threadData.value?.thread,
	(thread) => {
		const t2 = thread as { _id: string; snoozeReturnedAt?: number } | null | undefined;
		if (!t2?.snoozeReturnedAt) return;
		if (clearedSnoozeReturned.has(t2._id)) return;
		clearedSnoozeReturned.add(t2._id);
		void clearSnoozeReturnedOp.run({ threadId: t2._id as Id<'mailThreads'> });
	},
	{ immediate: true }
);

const expanded = ref<Set<string>>(new Set());

// Minute tick so the relative timestamps ("2h ago") stay fresh while a
// thread sits open. Presentation-only; the absolute datetime lives in the
// title tooltip.
const relativeTimeTick = ref(0);
let relativeTimeTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
	relativeTimeTimer = setInterval(() => {
		relativeTimeTick.value++;
	}, 60_000);
});
onBeforeUnmount(() => {
	if (relativeTimeTimer) clearInterval(relativeTimeTimer);
});
function relativeReceivedAt(timestamp: number): string {
	// Touch the tick so the computed template bindings re-run each minute.
	void relativeTimeTick.value;
	return formatCompactRelativeTime(timestamp);
}

// Adaptive dark rendering: per-message sun/moon escape hatch (in-memory only)
// forcing light rendering for a single message while the app is dark.
const { isDark: appIsDark } = useAppTheme();
const { isForcedLight, toggleForcedLight } = usePostboxForcedLight();

watch(
	allMessages,
	(messages) => {
		if (messages.length === 0) {
			expanded.value = new Set();
			return;
		}
		const next = new Set<string>();
		const last = messages[messages.length - 1];
		if (last) next.add(last._id);
		// Show first message too if more than 2
		const first = messages[0];
		if (messages.length > 2 && first) next.add(first._id);
		// Show all unread
		for (const m of messages) if (!m.flagSeen) next.add(m._id);
		// Always include the active message
		next.add(props.message._id);
		expanded.value = next;
	},
	{ immediate: true }
);

function toggleExpanded(id: string) {
	const next = new Set(expanded.value);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	expanded.value = next;
}

// --- Single-key shortcuts while reading (same vocabulary as the list; see
// utils/postboxShortcuts.ts). Registered on window, inert while focus is in
// an input/contenteditable, and deferring to the list's own listbox handler
// and to open dialogs so a key is never handled twice.
const mailboxIdRef = computed(() => props.message.mailboxId as Id<'mailboxes'>);
const readerBulk = usePostboxBulkActions(mailboxIdRef);
const { labels: readerLabels, setOnMessage: setLabelOnMessage } = usePostboxLabels(mailboxIdRef);
const { folders: readerFolders } = usePostboxFolders(mailboxIdRef);
const readerMovableFolders = computed(() =>
	readerFolders.value.filter((f) => f.role !== 'sent' && f.role !== 'drafts')
);

// Per-sender remote-image allowlist. One subscription for the whole thread —
// every message body asks this the same question, and a per-body query would
// open one subscription per rendered message.
const imageAllowlist = usePostboxImageAllowlist(mailboxIdRef);

const archiveOp = useBackendOperation(api.mail.messageActions.archive, {
	label: () => t('common.archive'),
});
const trashOp = useBackendOperation(api.mail.messageActions.trash, {
	label: () => t('components.postbox.postboxThreadReader.moveToTrashOperation'),
});
const setStarOp = useBackendOperation(api.mail.messageActions.setStar, {
	label: () => t('components.postbox.postboxThreadReader.star'),
});
const markReadOp = useBackendOperation(api.mail.messageActions.markRead, {
	label: () => t('components.postbox.postboxThreadReader.markReadOperation'),
});
const snoozeOp = useBackendOperation(api.mail.snooze.snooze, {
	label: () => t('components.postbox.postboxThreadReader.snoozeOperation'),
});
const snoozeUntilReplyOp = useBackendOperation(api.mail.snooze.snoozeUntilReply, {
	label: () => t('components.postbox.postboxThreadReader.snoozeUntilReplyOperation'),
});
const snoozeThreadOp = useBackendOperation(api.mail.snooze.snoozeThread, {
	label: () => t('components.postbox.postboxThreadReader.snoozeOperation'),
});
const setMutedOp = useBackendOperation(api.mail.mute.setMutedForMessage, {
	label: () => t('components.postbox.postboxThreadReader.muteOperation'),
});
const setNotifyOnReplyOp = useBackendOperation(api.mail.threadAlerts.setNotifyOnReplyForMessage, {
	label: () => t('components.postbox.postboxThreadReader.notifyOnReplyOperation'),
});
const moveOp = useBackendOperation(api.mail.messageActions.move, {
	label: () => t('components.postbox.postboxThreadReader.moveOperation'),
});

// Successful triage registers its inverse for the "Undo — Cmd+Z" toast
// (the move-family mutations return each message's source folder).
const triageUndo = usePostboxTriageUndo();
function registerTriageUndo(
	label: string,
	outcome: BackendOperationResult<{
		moved: Array<{ messageId: Id<'mailMessages'>; sourceFolderId: Id<'mailFolders'> }>;
	} | null>,
	before?: () => Promise<unknown>
) {
	if (!outcome.ok || !outcome.result || outcome.result.moved.length === 0) return;
	triageUndo.registerMoveBack({
		label,
		moved: outcome.result.moved,
		runMove: (a) => moveOp.run(a),
		...(before ? { before } : {}),
	});
}

// Reply / reply-all / forward composer concerns (popup openers, the pinned
// inline reply box, and the list→reader r/a/f hand-off).
const {
	openReplyAll,
	openPrimaryReply,
	openReplyWithBody,
	openForward,
	openResend,
	hasOtherRecipients,
	inlineSpec,
	inlineReplyEl,
	expandInline,
	guardedExpandReply,
	guardedExpandReplyAll,
	collapseInline,
	inlineSenderLabel,
} = usePostboxReaderComposer({
	getMessage: () => props.message,
	latestMessage,
	ownAddresses,
	replyDefault,
	// Route every in-composer reply/reply-all path (keyboard, inline box, list
	// hand-off) through the sender-auth reply guard against the latest message.
	guardReply: (run) => guardLatestReply(run),
});

// Sender-authentication badge (Sealed Mail A3, flag `senderAuthBadges`). The
// derivation is honest — absent verdicts yield no badge — so this is safe to
// compute for every message; the flag only decides whether it renders.
const authBadgesEnabled = computed(() => isFeatureEnabled('senderAuthBadges'));

// Sealed-Mail reader badge (E5, flag `sealedMail`). Gates the honest "Sealed —
// sender verified / not verified" / "can't decrypt" chip driven by the inbound
// sealing record. When off, sealed messages fall back to the structural badge.
const sealedMailEnabled = computed(() => isFeatureEnabled('sealedMail'));

// The thread's correspondent (Sealed Mail 1:1 plane, D5): the first party in the
// conversation who isn't us. Prefer an inbound sender; fall back to a recipient
// on an all-outbound thread. Drives the thread-level key-change banner + contact
// key panel. Empty when we can't identify a single counterpart (the container
// then renders nothing).
const threadCounterpart = computed(() => {
	const own = ownAddresses.value;
	for (const m of allMessages.value) {
		const from = extractEmailAddress(m.fromAddress).toLowerCase();
		if (from && !own.has(from)) return from;
	}
	for (const m of allMessages.value) {
		for (const to of m.toAddresses) {
			const addr = extractEmailAddress(to).toLowerCase();
			if (addr && !own.has(addr)) return addr;
		}
	}
	return '';
});

// Reply guard: intercept reply / reply-all with a one-time-per-thread confirm on
// the sender shapes a reply walks into (UX plan idea 56) — a DMARC failure, a
// pass belonging to another domain, a look-alike of a known contact's domain, or
// a Reply-To that redirects elsewhere. Everything else (and a flag-off state)
// passes straight through; DMARC→Spam routing is untouched.
const replyGuardEl = ref<{
	guard: (
		threadId: string,
		risk: ReplyRisk | null,
		destination: string,
		action: () => void
	) => void;
} | null>(null);

/** The reply risk for `msg`, or null when the badge flag is off. */
function replyRisk(msg: PostboxReaderMessage): ReplyRisk | null {
	if (!authBadgesEnabled.value) return null;
	return deriveReplyRisk(senderRiskInputOf(msg));
}

/**
 * Run `action` behind the reply guard for `msg`: a one-time-per-thread confirm
 * when the sender is in one of the flagged shapes, else straight through. Shared
 * by every reply/reply-all entry point (per-message buttons, keyboard, inline
 * box, list hand-off) so none of them can bypass the interstitial.
 *
 * The destination it names is the From address, because that is what a reply is
 * actually addressed to here (`buildReplySpec` prefills `To: [fromAddress]`) —
 * naming the Reply-To instead would describe a send this client does not make.
 */
function runGuarded(msg: PostboxReaderMessage | undefined, action: () => void) {
	if (!msg) {
		action();
		return;
	}
	const threadId = msg.threadId ?? msg._id;
	replyGuardEl.value?.guard(threadId, replyRisk(msg), extractEmailAddress(msg.fromAddress), action);
}

function guardedOpen(msg: PostboxReaderMessage, open: (m: PostboxReaderMessage) => void) {
	runGuarded(msg, () => open(msg));
}

function guardedReply(msg: PostboxReaderMessage) {
	guardedOpen(msg, openPrimaryReply);
}

function guardedReplyAll(msg: PostboxReaderMessage) {
	guardedOpen(msg, openReplyAll);
}

/** Guard a reply/reply-all against the LATEST message (keyboard/inline paths). */
function guardLatestReply(run: () => void) {
	runGuarded(latestMessage.value, run);
}

async function runAndAdvance(run: () => Promise<BackendOperationResult<unknown>>) {
	// Capture the target before the mutation — the live list drops the
	// triaged row once the server confirms, shifting the indices.
	const target = props.folderRole
		? pickAdjacentMessageId(props.advanceIds ?? [], props.message._id, autoAdvance.value)
		: null;
	const outcome = await run();
	// Stay put only on THROWN errors — useBackendOperation's catch path maps
	// those to `ok: false`. Anything the server returns (incl. a handler
	// `return undefined`, which Convex serializes to `null` on the client —
	// e.g. archive/trash's row-already-gone soft-fail, or snooze's void
	// success) still advances; that's fine because the row is gone either way.
	if (!outcome.ok) return;
	// Overlay host: swap the reader in place (or close it at the list's ends)
	// instead of leaving the Today surface for the three-pane route.
	if (props.advanceInPlace) {
		emit('advance', target);
		return;
	}
	if (!props.folderRole) return;
	void navigateTo(
		target
			? `/dashboard/postbox/${props.folderRole}/${target}`
			: `/dashboard/postbox/${props.folderRole}`
	);
}

// Live flags of the open message (the prop can be a stale list row).
const openMessageFlags = computed(() => {
	const live = allMessages.value.find((m) => m._id === props.message._id) as
		| { flagSeen?: boolean; flagFlagged?: boolean }
		| undefined;
	return {
		seen: live?.flagSeen ?? props.message.flagSeen ?? true,
		flagged: live?.flagFlagged ?? false,
	};
});

const snoozeDialogOpen = ref(false);
const labelDialogOpen = ref(false);
const moveDialogOpen = ref(false);

function snoozeOpenMessage(until: number, scope: PostboxSnoozeScope) {
	const threadId = readerThread.value?._id;
	// Thread scope is the dialog's default; a reader opened on a row whose thread
	// hasn't loaded yet falls back to deferring just this message.
	if (scope === 'thread' && threadId) {
		void runAndAdvance(() =>
			snoozeThreadOp.run({ threadId: threadId as Id<'mailThreads'>, until })
		);
		return;
	}
	void runAndAdvance(() => snoozeOp.run({ messageId: messageId.value, until }));
}

/**
 * Mute/unmute the open conversation. Muting archives the thread's inbox mail
 * server-side, so it triages the reader away exactly like archive does;
 * unmuting only drops the marker and keeps the thread open.
 */
const isThreadMuted = computed(() => readerThread.value?.mutedAt != null);
function toggleOpenThreadMute() {
	const muted = !isThreadMuted.value;
	if (muted) {
		void runAndAdvance(() => setMutedOp.run({ messageId: messageId.value, muted: true }));
		return;
	}
	void setMutedOp.run({ messageId: messageId.value, muted: false });
}
/**
 * Arm/disarm "notify me when they reply" on the open conversation. Purely a
 * notification preference — unlike mute it moves no mail, so the reader stays
 * exactly where it is. The server keeps it mutually exclusive with mute.
 */
const isThreadAlerted = computed(() => readerThread.value?.notifyOnReplyAt != null);
function toggleOpenThreadAlert() {
	void setNotifyOnReplyOp.run({
		messageId: messageId.value,
		enabled: !isThreadAlerted.value,
	});
}
function snoozeOpenMessageUntilReply(capUntil: number) {
	void runAndAdvance(() => snoozeUntilReplyOp.run({ messageId: messageId.value, capUntil }));
}
// Subject + snippet feed the deterministic wake-time suggestion in the dialog.
const snoozeHintText = computed(() =>
	[props.message.subject, props.message.snippet].filter(Boolean).join(' ')
);
async function applyLabelToOpenMessage(labelId: Id<'mailLabels'>) {
	labelDialogOpen.value = false;
	await setLabelOnMessage(messageId.value, labelId, true);
}
async function moveOpenMessageTo(targetFolderId: Id<'mailFolders'>) {
	moveDialogOpen.value = false;
	const result = await moveOp.run({ messageIds: [messageId.value], targetFolderId });
	registerTriageUndo(t('components.postbox.postboxThreadReader.undoMoved'), result);
}

/**
 * Run a thread-level action against the OPEN message. Shared by the keyboard
 * shortcuts, the palette-command bridge, and the reader toolbar so a demoted
 * action stays reachable from every entry point (keyboard, Cmd-K, overflow).
 */
function runReaderAction(action: string) {
	switch (action) {
		case 'archive':
			void runAndAdvance(async () => {
				const result = await archiveOp.run({ messageIds: [messageId.value] });
				registerTriageUndo(t('components.postbox.postboxThreadReader.undoArchived'), result);
				return result;
			});
			break;
		case 'trash':
			void runAndAdvance(async () => {
				const result = await trashOp.run({ messageIds: [messageId.value] });
				registerTriageUndo(t('components.postbox.postboxThreadReader.undoTrashed'), result);
				return result;
			});
			break;
		case 'star':
			void setStarOp.run({ messageId: messageId.value, starred: !openMessageFlags.value.flagged });
			break;
		case 'toggleRead':
			void markReadOp.run({ messageId: messageId.value, seen: !openMessageFlags.value.seen });
			break;
		case 'markUnread':
			void markReadOp.run({ messageId: messageId.value, seen: false });
			break;
		case 'toggleSelect':
			readerBulk.toggle(messageId.value);
			break;
		case 'reply':
			guardedExpandReply();
			break;
		case 'replyAll':
			guardedExpandReplyAll();
			break;
		case 'forward':
			void expandInline('forward');
			break;
		case 'snooze':
			snoozeDialogOpen.value = true;
			break;
		case 'mute':
			toggleOpenThreadMute();
			break;
		case 'label':
			labelDialogOpen.value = true;
			break;
		case 'move':
			moveDialogOpen.value = true;
			break;
		case 'reportSpam':
			reportSpamMessage(props.message._id);
			break;
		case 'blockSender':
			blockSenderOf(props.message._id);
			break;
		case 'print':
			if (typeof window !== 'undefined') window.print();
			break;
	}
}

function onReaderShortcut(event: KeyboardEvent) {
	// Alt matters too: on Windows the browser-menu accelerators (Alt+E, Alt+F)
	// deliver plain keydowns with altKey — never treat those as triage keys.
	if (event.metaKey || event.ctrlKey || event.altKey) return;
	if (isEditableTarget(event.target)) return;
	// Already claimed on the way up — most often the second half of a `g`
	// sequence chord, which the app-wide dispatcher completed at the document
	// level. Acting on it here as well would star AND navigate on `g` `s`.
	if (event.defaultPrevented) return;
	const el = event.target as HTMLElement | null;
	// The focused thread list and any open dialog own their keys.
	if (el?.closest?.('[role="listbox"], [role="dialog"]')) return;
	const action = resolvePostboxShortcut(event.key);
	// '?' is handled by the window-level PostboxShortcutHelp listener.
	if (!action || action === 'help') return;
	event.preventDefault();
	runReaderAction(action);
}

// Bridge for the Cmd-K palette: commands demoted into overflow menus (reply-all,
// forward, report spam, block sender, print, …) dispatch this event so they
// stay discoverable and runnable without a visible button.
function onPaletteCommand(event: Event) {
	const detail = (event as CustomEvent<{ action?: string; labelId?: string }>).detail;
	if (!detail?.action) return;
	// "Label as…" is the one palette command that carries an argument (the
	// chosen label), so it lands here rather than in the argument-less switch.
	if (detail.action === 'label') {
		if (detail.labelId) void applyLabelToOpenMessage(detail.labelId as Id<'mailLabels'>);
		return;
	}
	runReaderAction(detail.action);
}

onMounted(() => {
	window.addEventListener('keydown', onReaderShortcut);
	window.addEventListener('owlat:postbox-reader-action', onPaletteCommand);
});
onBeforeUnmount(() => {
	window.removeEventListener('keydown', onReaderShortcut);
	window.removeEventListener('owlat:postbox-reader-action', onPaletteCommand);
});

const reportSpamOp = useBackendOperation(api.mail.messageActions.reportSpam, {
	label: () => t('components.postbox.postboxThreadReader.reportSpam'),
});
const notSpamOp = useBackendOperation(api.mail.messageActions.notSpam, {
	label: () => t('components.postbox.postboxThreadReader.notSpamOperation'),
});
const blockSenderOp = useBackendOperation(api.mail.messageActions.blockSender, {
	label: () => t('components.postbox.postboxThreadReader.blockSender'),
});

function reportSpamMessage(msgId: string) {
	const messageIds = [msgId as Id<'mailMessages'>];
	const run = async () => {
		const result = await reportSpamOp.run({ messageIds });
		// Undo = notSpam (clears the verdict, parks in Inbox) + move back to
		// the true source folder when it wasn't the Inbox.
		registerTriageUndo(t('components.postbox.postboxThreadReader.undoSpam'), result, () =>
			notSpamOp.run({ messageIds })
		);
		return result;
	};
	// Only the OPEN message's spam report ejects the reader; reporting an
	// older message inside the thread keeps the conversation open.
	if (msgId === props.message._id) void runAndAdvance(run);
	else void run();
}

function blockSenderOf(msgId: string) {
	void blockSenderOp.run({ messageId: msgId as Id<'mailMessages'> });
}

/** Live starred state of a specific message in the thread. */
function isMessageStarred(msg: { _id: string; flagFlagged?: boolean }): boolean {
	const live = allMessages.value.find((m) => m._id === msg._id) as
		| { flagFlagged?: boolean }
		| undefined;
	return live?.flagFlagged ?? msg.flagFlagged ?? false;
}

/** Toggle the star on a specific message (per-row affordance). */
function toggleMessageStar(msg: { _id: string; flagFlagged?: boolean }) {
	void setStarOp.run({
		messageId: msg._id as Id<'mailMessages'>,
		starred: !isMessageStarred(msg),
	});
}

const downloadingAttachment = ref<string | null>(null);

type AttachmentMeta = {
	filename: string;
	contentType: string;
	size: number;
	partIndex?: string;
};

function isPreviewable(contentType: string): boolean {
	return contentType.startsWith('image/') || contentType === 'application/pdf';
}

/** Fetch the raw .eml and extract one part client-side as a Blob. */
async function extractAttachmentBlob(
	messageId: string,
	att: { filename: string; contentType: string; partIndex?: string }
): Promise<Blob | null> {
	const bin = await loadRawEml(messageId);
	if (!bin) return null;
	const extracted = extractAttachmentAt(bin, att.partIndex ?? '0', att.filename);
	if (!extracted) return null;
	return new Blob([extracted.bytes as BlobPart], {
		type: extracted.contentType || att.contentType,
	});
}

/** Extract the part, then trigger a browser download. */
async function handleAttachmentDownload(
	messageId: string,
	att: { filename: string; contentType: string; partIndex?: string }
) {
	const key = `${messageId}:${att.partIndex ?? att.filename}`;
	downloadingAttachment.value = key;
	try {
		const blob = await extractAttachmentBlob(messageId, att);
		// A null blob is a failure too: the raw message did not load, or the part
		// is not where the metadata said it was. Both used to end as a spinner
		// that stopped and a file that never arrived.
		if (!blob) {
			showToast(t('components.postbox.postboxThreadReader.attachmentDownloadFailed'), 'error');
			return;
		}
		const objectUrl = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = objectUrl;
		a.download = att.filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
	} catch (err) {
		// A dropped connection reads as "Check your connection"; anything else
		// gets the attachment-specific line. Either way the reader hears about it
		// — the row stays available to try again.
		showOperationError(err, 'components.postbox.postboxThreadReader.attachmentDownloadFailed');
	} finally {
		downloadingAttachment.value = null;
	}
}

// Quick Look overlay state: the clicked message's PREVIEWABLE attachments in
// display order plus the index of the one that was clicked. Null = closed.
const lightbox = ref<{
	messageId: string;
	attachments: AttachmentMeta[];
	index: number;
} | null>(null);

function openAttachmentPreview(messageId: string, att: AttachmentMeta, all: AttachmentMeta[]) {
	const previewable = all.filter((a) => isPreviewable(a.contentType));
	const index = previewable.indexOf(att);
	if (index === -1) return;
	lightbox.value = { messageId, attachments: previewable, index };
}

function loadLightboxPart(att: AttachmentMeta): Promise<Blob | null> {
	const lb = lightbox.value;
	return lb ? extractAttachmentBlob(lb.messageId, att) : Promise.resolve(null);
}

/**
 * Open the filter builder pre-filled from this message.
 *
 * The moment someone thinks "I want a rule for this" is while looking at the
 * mail, not while staring at an empty rule form in Preferences — so the sender
 * and the normalized subject travel along as query params (a shareable deep
 * link that survives a reload) and the builder seeds its conditions from them.
 */
function createFilterFrom(msg: { fromAddress?: string; subject?: string }) {
	const query: Record<string, string> = {};
	if (msg.fromAddress) query['filterFrom'] = msg.fromAddress;
	// Strip the Re:/Fwd: run: a rule keyed on "Re: Invoice 4471" would miss the
	// original and every future thread on the same subject.
	const subject = (msg.subject ?? '').replace(/^((re|fwd|fw|aw|wg)\s*:\s*)+/i, '').trim();
	if (subject) query['filterSubject'] = subject;
	if (Object.keys(query).length === 0) return;
	void navigateTo({ path: '/dashboard/preferences/filters', query });
}

function downloadLightboxAttachment(att: AttachmentMeta) {
	const lb = lightbox.value;
	if (lb) void handleAttachmentDownload(lb.messageId, att);
}
</script>

<template>
	<article class="pbx-reader-article p-6 max-w-4xl mx-auto">
		<PostboxThreadHeader
			:subject="message.subject"
			:message-count="allMessages.length"
			:message-id="messageId"
			:thread="readerThread"
			:latest-outbound-id="latestOutboundId"
			:label-ids="threadLabels"
			:labels="labelMap"
			:show-mark-read="showsManualMarkReadButton"
			:marking-read="markThreadReadOp.isLoading.value"
			@toggle-mute="toggleOpenThreadMute"
			@toggle-alert="toggleOpenThreadAlert"
			@mark-read="markOpenThreadRead"
		/>

		<!-- The same conversation, seen from the other surface (idea 31). Renders
		     only when this message ALSO exists in the Team Inbox and the viewer is
		     permitted on both sides; read-only, and it merges nothing. -->
		<PostboxCrossSurfaceStrip :message-id="messageId" class="mb-3" />

		<!-- Sealed Mail (E5): thread-level trust surfaces for the correspondent —
		     the Signal-style key-change banner (explicit re-pin) + the contact key
		     panel. Flag-gated; renders nothing without a key on file. -->
		<PostboxThreadSealSurfaces
			v-if="sealedMailEnabled && threadCounterpart"
			:correspondent="threadCounterpart"
			class="mb-3"
		/>

		<!-- Layout-matching skeleton while the thread loads (header is already
		     rendered above from the list row, so only the message card shimmers). -->
		<PostboxReaderSkeleton v-if="isLoading" />

		<div v-else class="space-y-2">
			<!-- The reader's ONE AI home: a single quiet strip with the summary gist
			     plus Ask + Draft reply. Renders nothing when there's no summary and
			     the thread is too short to warrant one (fail-soft, same thresholds). -->
			<PostboxAiStrip
				v-if="showAiStrip && latestMessage"
				:key="latestMessage._id"
				:message-id="latestMessage._id"
				:warrants-summary="warrantsSummary"
				@use-reply="(t) => latestMessage && openReplyWithBody(latestMessage, t)"
			/>

			<PostboxReaderMessage
				v-for="msg in allMessages"
				:key="msg._id"
				:message="msg"
				:mailbox-id="message.mailboxId"
				:expanded="expanded.has(msg._id)"
				:relative-time="relativeReceivedAt(msg.receivedAt)"
				:starred="isMessageStarred(msg)"
				:show-reply-all="hasOtherRecipients(msg)"
				:show-sender-controls="!ownAddresses.has(extractEmailAddress(msg.fromAddress))"
				:auth-enabled="authBadgesEnabled"
				:sealed-enabled="sealedMailEnabled"
				:secure-class="secureClass(msg)"
				:hide-body="hideRawBody(msg)"
				:tracker="trackerDetection(msg)"
				:delivery="deliveryFor(msg)"
				:scheduling-times="schedulingTimesFor(msg)"
				:show-render-toggle="appIsDark"
				:forced-light="isForcedLight(msg._id)"
				:images-allowed="imageAllowlist.isAllowed(msg.fromAddress)"
				:own-email="ownEmail"
				:has-invite="!!calendarAttachment(msg)"
				:downloading-attachment="downloadingAttachment"
				@toggle-expanded="toggleExpanded(msg._id)"
				@open-sender-profile="openSenderProfile(msg)"
				@toggle-forced-light="toggleForcedLight(msg._id)"
				@toggle-star="toggleMessageStar(msg)"
				@reply="guardedReply(msg)"
				@reply-all="guardedReplyAll(msg)"
				@forward="openForward(msg)"
				@report-spam="reportSpamMessage(msg._id)"
				@block-sender="blockSenderOf(msg._id)"
				@create-filter="createFilterFrom(msg)"
				@print="runReaderAction('print')"
				@preview-attachment="(att, all) => openAttachmentPreview(msg._id, att, all)"
				@download-attachment="(att) => handleAttachmentDownload(msg._id, att)"
				@trackers="onTrackersDetected(msg._id, $event)"
				@trust-sender="imageAllowlist.allow($event)"
				@untrust-sender="imageAllowlist.revoke($event)"
				@resend="(addresses) => openResend(msg, addresses)"
				@use-reply="(text) => openReplyWithBody(msg, text)"
				@dismiss-scheduling="dismissScheduling(msg._id)"
			/>

			<!-- Inline reply box pinned under the conversation (r / a / f or the
			     affordance expand it; it collapses back after send/discard). -->
			<PostboxInlineReply
				v-if="latestMessage"
				ref="inlineReplyEl"
				:sender-label="inlineSenderLabel"
				:show-reply-all="hasOtherRecipients(latestMessage)"
				:spec="inlineSpec"
				@expand="
					(kind) =>
						kind === 'reply'
							? guardedExpandReply()
							: kind === 'replyAll'
								? guardedExpandReplyAll()
								: void expandInline(kind)
				"
				@collapse="collapseInline"
			/>

			<!-- "You archive everything from this sender. Always archive it?"
			     (idea 27). Foot of the reader, under the conversation: it is an
			     observation about the SENDER, not about this message. Strictly an
			     offer — it renders nothing until a sender's tally earns one, and
			     nothing is ever applied without the explicit click. -->
			<PostboxTriageSuggestion v-if="latestMessage" :message-id="latestMessage._id" />
		</div>

		<!-- One-time-per-thread confirm before replying to a message that failed
		     sender authentication (flag `senderAuthBadges`). -->
		<PostboxReplyGuard ref="replyGuardEl" />

		<!-- Keyboard-flow pickers for the open message (h / l / v). -->
		<PostboxSnoozeDialog
			:open="snoozeDialogOpen"
			:hint-text="snoozeHintText"
			scoped
			@update:open="snoozeDialogOpen = $event"
			@confirm="snoozeOpenMessage"
			@confirm-until-reply="snoozeOpenMessageUntilReply"
		/>
		<PostboxLabelPickerDialog
			:open="labelDialogOpen"
			:labels="readerLabels"
			@update:open="labelDialogOpen = $event"
			@pick="applyLabelToOpenMessage"
		/>
		<PostboxMovePickerDialog
			:open="moveDialogOpen"
			:folders="readerMovableFolders"
			@update:open="moveDialogOpen = $event"
			@pick="moveOpenMessageTo"
		/>

		<!-- Plan idea 45: one slide-over for whichever sender line was clicked. -->
		<PostboxSenderProfile
			v-if="senderProfile"
			:open="true"
			:mailbox-id="message.mailboxId"
			:from-address="senderProfile.fromAddress"
			:from-name="senderProfile.fromName"
			@update:open="(open: boolean) => !open && (senderProfile = null)"
		/>

		<!-- Quick Look overlay for image/PDF attachments (Teleports to body). -->
		<PostboxAttachmentLightbox
			v-if="lightbox"
			:attachments="lightbox.attachments"
			:initial-index="lightbox.index"
			:load-part="loadLightboxPart"
			@close="lightbox = null"
			@download="downloadLightboxAttachment"
		/>
	</article>
</template>
