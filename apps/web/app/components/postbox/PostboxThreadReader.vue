<script lang="ts">
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
	dmarcResult?: string;
	flagSeen?: boolean;
	unsubscribe?: { httpUrl?: string; mailtoUrl?: string; oneClick: boolean };
};
</script>

<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { extractAttachmentAt } from '@owlat/shared/mailMime';
import { extractEmailAddress } from '~/utils/emailAddress';
import { formatCompactRelativeTime, formatDateTime } from '~/utils/formatters';
import { isLongThreadForSummary } from '~/utils/postboxAutoSummary';
import { deriveReplyAllExtras } from '~/utils/recipientHints';
import { resolvePrimaryReplyKind } from '~/utils/postboxReplyDefault';
import { shouldShowSchedulingChip } from '~/utils/postboxSchedulingChip';
import type { PostboxPendingCompose } from '~/utils/postboxShortcuts';
import type {
	ComposerSpec,
	InlineComposeKind,
	InlineComposeSpec,
} from '~/composables/postbox/usePostboxComposerStack';
import {
	classifySecureMessage,
	isEncryptedClass,
	type SecureMessageClass,
} from '@owlat/shared/secureMessage';
import type { TrackerDetection } from '@owlat/shared/postboxTrackers';

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

const stack = usePostboxComposerStack();
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

const messageId = computed(() => props.message._id as Id<'mailMessages'>);
const { data: threadData, isLoading } = useConvexQuery(api.mail.mailbox.listThreadMessages, () => ({
	messageId: messageId.value,
}));

const allMessages = computed(() => threadData.value?.messages ?? [props.message]);
const latestMessage = computed(() => allMessages.value[allMessages.value.length - 1]);

// Auto-summary strip: advisory AI, shown above long threads only. Long =
// >= 5 messages OR a lot of body text (a single sprawling message still
// benefits from a TL;DR). Gated by the `ai` flag AND the per-user toggle
// (default ON); the strip itself reads the cache reactively and generates
// lazily, so this only decides whether to mount it.
const { autoSummarize } = usePostboxSettings();
const showSummaryStrip = computed(
	() =>
		isFeatureEnabled('ai') &&
		autoSummarize.value &&
		isLongThreadForSummary(allMessages.value) &&
		!!latestMessage.value
);

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
function showSchedulingChip(msg: {
	_id: string;
	attachments: Array<{ filename: string; contentType: string; partIndex?: string }>;
}): boolean {
	const intent = schedulingIntent.value;
	return shouldShowSchedulingChip({
		aiEnabled: isFeatureEnabled('ai'),
		meetingIntent: intent ? { isScheduling: true, proposedTimes: intent.proposedTimes } : null,
		triggerMessageId: intent?.messageId,
		message: msg,
		dismissed: dismissedScheduling.value,
	});
}

// Mark-as-read on open (Gmail conversation-view semantics): the first time an
// unread thread is opened, clear its unread flags. Guarded so the reactive
// re-fetch that follows (flagSeen flips → query re-runs) doesn't re-fire.
const markThreadReadOp = useBackendOperation(api.mail.messageActions.markThreadRead, {
	label: 'Mark read',
});
const markedThreads = new Set<string>();
watch(
	() => threadData.value,
	(data) => {
		const thread = data?.thread;
		if (!thread) return;
		if (markedThreads.has(thread._id)) return;
		const hasUnread = (data?.messages ?? []).some((m) => !m.flagSeen);
		if (!hasUnread) return;
		markedThreads.add(thread._id);
		void markThreadReadOp.run({
			threadId: thread._id as Id<'mailThreads'>,
			seen: true,
		});
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

type ReplyForwardSource = {
	_id: string;
	subject: string;
	fromAddress: string;
	fromName?: string;
	toAddresses: string[];
	ccAddresses: string[];
	receivedAt: number;
	htmlBodyInline?: string;
	textBodyInline?: string;
};

/**
 * Build the one-time compose seed for a reply / reply-all / forward of
 * `source` — shared by the popup openers below and the inline reply box, so
 * both paths produce identical drafts (quoting, recipients, subject prefix).
 */
async function buildComposeSpec(
	kind: InlineComposeKind,
	source: ReplyForwardSource
): Promise<Omit<ComposerSpec, 'id' | 'minimized'>> {
	const target = await resolveBodyFields(source);
	const mailboxId = props.message.mailboxId as Id<'mailboxes'>;
	if (kind === 'forward') {
		return {
			mailboxId,
			prefillSubject: target.subject.match(/^fwd?\s*:\s*/i)
				? target.subject
				: `Fwd: ${target.subject}`,
			prefillBodyHtml: buildForwardedBody(target),
			forwardAttachmentsFromMessageId: target._id as Id<'mailMessages'>,
		};
	}
	const spec: Omit<ComposerSpec, 'id' | 'minimized'> = buildReplySpec(mailboxId, target);
	const extras = deriveReplyAllExtras(target, [...ownAddresses.value]);
	if (kind === 'replyAll') {
		spec.prefillCc = extras;
	} else if (kind === 'reply' && extras.length > 0) {
		// Surface the "Also include …?" gap hint in the composer.
		spec.replyAllRecipients = extras;
	}
	return spec;
}

async function openReplyAll(replyTo?: ReplyForwardSource) {
	stack.open(await buildComposeSpec('replyAll', replyTo ?? props.message));
}

/**
 * The reply kind the PRIMARY affordance (Reply button / `r`) opens: honors the
 * user's default-reply preference, collapsing to a plain reply when reply-all
 * would add no one. The explicit Reply-all button / `a` bypass this.
 */
function primaryReplyKind(source: {
	fromAddress: string;
	toAddresses: string[];
	ccAddresses: string[];
}): InlineComposeKind {
	return resolvePrimaryReplyKind(replyDefault.value, hasOtherRecipients(source));
}

/** Open the popup composer for the primary reply (per the default preference). */
async function openPrimaryReply(replyTo?: ReplyForwardSource) {
	const source = replyTo ?? props.message;
	stack.open(await buildComposeSpec(primaryReplyKind(source), source));
}

/** Whether Reply-All would add anyone beyond a plain Reply (extra To/Cc). */
function hasOtherRecipients(msg: {
	fromAddress: string;
	toAddresses: string[];
	ccAddresses: string[];
}) {
	const seen = new Set<string>([extractEmailAddress(msg.fromAddress), ...ownAddresses.value]);
	return [...msg.toAddresses, ...msg.ccAddresses].some((a) => {
		const c = extractEmailAddress(a);
		return c.length > 0 && !seen.has(c);
	});
}

/** Open a reply seeded with an AI-suggested body (above the quoted original). */
async function openReplyWithBody(replyTarget: ReplyForwardSource, bodyText: string) {
	const target = await resolveBodyFields(replyTarget);
	stack.open(buildReplySpec(props.message.mailboxId as Id<'mailboxes'>, target, bodyText));
}

async function openForward(msg?: ReplyForwardSource) {
	stack.open(await buildComposeSpec('forward', msg ?? props.message));
}

// --- Inline reply box pinned under the conversation (Spark-style). Expands
// via the collapsed affordance or the r/a/f keys; the popup path above stays
// for the per-message Reply/Forward buttons inside the thread. Both share
// buildComposeSpec, so the inline draft carries the same quoted text and
// recipients as a popup reply would.
const inlineSpec = ref<InlineComposeSpec | null>(null);
const inlineReplyEl = ref<{ focusEditor: () => void } | null>(null);
let inlineSeq = 0;

async function expandInline(kind: InlineComposeKind) {
	const target = latestMessage.value;
	if (!target) return;
	if (inlineSpec.value?.kind === kind) {
		// Already open in this mode — just re-focus it (r/a re-press).
		inlineReplyEl.value?.focusEditor();
		return;
	}
	const seq = ++inlineSeq;
	const seed = await buildComposeSpec(kind, target);
	// Superseded by a newer expand or a thread change while resolving the body.
	if (seq !== inlineSeq) return;
	inlineSpec.value = { ...seed, kind, key: `${target._id}:${kind}` };
}

/**
 * Expand the inline box for the PRIMARY reply (Reply affordance / `r`): honors
 * the default-reply preference, opening a reply-all when the user prefers it
 * and the message actually has other recipients. The explicit `a` / Reply-all
 * icon call expandInline('replyAll') directly and bypass this.
 */
async function expandPrimaryReply() {
	const target = latestMessage.value;
	if (!target) return;
	await expandInline(primaryReplyKind(target));
}

function collapseInline() {
	inlineSeq++;
	inlineSpec.value = null;
}

// A newly opened conversation always starts collapsed (and therefore can
// never steal focus on thread open).
watch(
	() => props.message.threadId ?? props.message._id,
	() => collapseInline()
);

const inlineSenderLabel = computed(() => {
	const m = latestMessage.value;
	return m ? m.fromName || m.fromAddress : '';
});

// Consume a pending compose intent set by the thread list's r/a/f shortcuts:
// the list opens the message, then we open the matching composer once this
// reader renders it (the quoting/recipient logic lives here).
const pendingCompose = useState<PostboxPendingCompose | null>(
	POSTBOX_PENDING_COMPOSE_KEY,
	() => null
);
// Watch the intent as well as the id: r/a/f on a row whose message is already
// open never changes `props.message._id`. Stale intents (id changed to a
// non-matching message) are dropped so they can't fire on a later plain open;
// see settlePendingCompose in utils/postboxShortcuts.ts.
watch(
	[() => props.message._id, pendingCompose] as const,
	([id], prev) => {
		const { open, clear } = settlePendingCompose(pendingCompose.value, id, prev?.[0]);
		if (clear) pendingCompose.value = null;
		if (open === 'reply') void expandPrimaryReply();
		else if (open === 'replyAll') void expandInline('replyAll');
		else if (open === 'forward') void expandInline('forward');
	},
	{ immediate: true }
);

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

const archiveOp = useBackendOperation(api.mail.messageActions.archive, { label: 'Archive' });
const trashOp = useBackendOperation(api.mail.messageActions.trash, { label: 'Move to trash' });
const setStarOp = useBackendOperation(api.mail.messageActions.setStar, { label: 'Star' });
const markReadOp = useBackendOperation(api.mail.messageActions.markRead, { label: 'Mark read' });
const snoozeOp = useBackendOperation(api.mail.snooze.snooze, { label: 'Snooze' });
const snoozeUntilReplyOp = useBackendOperation(api.mail.snooze.snoozeUntilReply, {
	label: 'Snooze until reply',
});
const moveOp = useBackendOperation(api.mail.messageActions.move, { label: 'Move message' });

// Successful triage registers its inverse for the "Undo — Cmd+Z" toast
// (the move-family mutations return each message's source folder).
const triageUndo = usePostboxTriageUndo();
function registerTriageUndo(
	label: string,
	result:
		| { moved: Array<{ messageId: Id<'mailMessages'>; sourceFolderId: Id<'mailFolders'> }> }
		| null
		| undefined,
	before?: () => Promise<unknown>
) {
	if (!result || result.moved.length === 0) return;
	triageUndo.registerMoveBack({
		label,
		moved: result.moved,
		runMove: (a) => moveOp.run(a),
		...(before ? { before } : {}),
	});
}

// Auto-advance after triaging the open message away (archive / trash /
// snooze / spam): open the adjacent conversation in list order per the
// user's preference, falling back to the list at the ends. Active only in
// the folder view (advance props present); the search preview stays put.
const { autoAdvance, replyDefault } = usePostboxSettings();

async function runAndAdvance(run: () => Promise<unknown>) {
	// Capture the target before the mutation — the live list drops the
	// triaged row once the server confirms, shifting the indices.
	const target = props.folderRole
		? pickAdjacentMessageId(props.advanceIds ?? [], props.message._id, autoAdvance.value)
		: null;
	const result = await run();
	// Stay put only on THROWN errors — useBackendOperation's catch path maps
	// those to `undefined`. Anything the server returns (incl. a handler
	// `return undefined`, which Convex serializes to `null` on the client —
	// e.g. archive/trash's row-already-gone soft-fail, or snooze's void
	// success) still advances; that's fine because the row is gone either way.
	if (result === undefined) return;
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

function snoozeOpenMessage(until: number) {
	void runAndAdvance(() => snoozeOp.run({ messageId: messageId.value, until }));
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
	registerTriageUndo('Moved', result);
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
				registerTriageUndo('Archived', result);
				return result;
			});
			break;
		case 'trash':
			void runAndAdvance(async () => {
				const result = await trashOp.run({ messageIds: [messageId.value] });
				registerTriageUndo('Moved to Trash', result);
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
			void expandPrimaryReply();
			break;
		case 'replyAll':
			void expandInline('replyAll');
			break;
		case 'forward':
			void expandInline('forward');
			break;
		case 'snooze':
			snoozeDialogOpen.value = true;
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
	const action = (event as CustomEvent<{ action?: string }>).detail?.action;
	if (action) runReaderAction(action);
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
	label: 'Report spam',
});
const notSpamOp = useBackendOperation(api.mail.messageActions.notSpam, {
	label: 'Not spam',
});
const blockSenderOp = useBackendOperation(api.mail.messageActions.blockSender, {
	label: 'Block sender',
});

function reportSpamMessage(msgId: string) {
	const messageIds = [msgId as Id<'mailMessages'>];
	const run = async () => {
		const result = await reportSpamOp.run({ messageIds });
		// Undo = notSpam (clears the verdict, parks in Inbox) + move back to
		// the true source folder when it wasn't the Inbox.
		registerTriageUndo('Marked as spam', result, () => notSpamOp.run({ messageIds }));
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
		if (!blob) return;
		const objectUrl = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = objectUrl;
		a.download = att.filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
	} catch {
		// Network/extraction failure — silently no-op (the row stays available).
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

function downloadLightboxAttachment(att: AttachmentMeta) {
	const lb = lightbox.value;
	if (lb) void handleAttachmentDownload(lb.messageId, att);
}
</script>

<template>
	<article class="pbx-reader-article p-6 max-w-4xl mx-auto">
		<header class="pbx-reader-header mb-4">
			<h1 class="text-2xl font-semibold text-text-primary">
				{{ message.subject || '(no subject)' }}
				<span
					v-if="allMessages.length > 1"
					class="ml-1 text-base font-normal text-text-tertiary align-middle"
				>
					({{ allMessages.length }})
				</span>
			</h1>
			<PostboxFollowUpChip
				v-if="readerThread"
				:thread="readerThread"
				:latest-outbound-id="latestOutboundId"
				class="mt-2"
			/>
			<div v-if="threadLabels.length > 0" class="mt-2 flex flex-wrap items-center gap-1.5">
				<span
					v-for="labelId in threadLabels"
					:key="labelId"
					class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs"
					:style="{
						backgroundColor: (labelMap.get(labelId)?.color || '#6b7280') + '20',
						color: labelMap.get(labelId)?.color || '#6b7280',
					}"
				>
					<span
						class="w-1.5 h-1.5 rounded-full"
						:style="{ backgroundColor: labelMap.get(labelId)?.color || '#6b7280' }"
					/>
					{{ labelMap.get(labelId)?.name }}
				</span>
			</div>
		</header>

		<!-- Layout-matching skeleton while the thread loads (header is already
		     rendered above from the list row, so only the message card shimmers). -->
		<PostboxReaderSkeleton v-if="isLoading" />

		<div v-else class="space-y-2">
			<!-- Advisory AI: cached one-line summary strip for long threads. Shows a
			     quiet shimmer while it fills in and disappears entirely on AI failure. -->
			<PostboxThreadSummary
				v-if="showSummaryStrip && latestMessage"
				:key="latestMessage._id"
				:message-id="latestMessage._id"
			/>

			<template v-for="msg in allMessages" :key="msg._id">
				<!-- Collapsed message header -->
				<button
					v-if="!expanded.has(msg._id)"
					type="button"
					class="w-full flex items-center gap-3 px-3 py-2 rounded border border-border-subtle bg-bg-surface text-left hover:bg-bg-elevated"
					@click="toggleExpanded(msg._id)"
				>
					<UiAvatar
						:name="msg.fromName"
						:email="msg.fromAddress"
						deterministic-color
						size="md"
						class="flex-shrink-0"
						aria-hidden="true"
					/>
					<div class="flex-1 min-w-0">
						<p class="text-sm truncate">
							<span class="font-medium text-text-primary">{{
								msg.fromName || msg.fromAddress
							}}</span>
							<template v-if="msg.snippet">
								<span class="text-text-tertiary mx-1.5">·</span>
								<span class="text-text-tertiary">{{ msg.snippet }}</span>
							</template>
						</p>
					</div>
					<span
						class="text-xs text-text-tertiary tabular-nums whitespace-nowrap flex-shrink-0"
						:title="formatDateTime(msg.receivedAt)"
					>
						{{ relativeReceivedAt(msg.receivedAt) }}
					</span>
				</button>

				<!-- Expanded message -->
				<section v-else class="group border border-border-subtle rounded bg-bg-surface px-4 py-3">
					<header class="flex items-start gap-3">
						<UiAvatar
							:name="msg.fromName"
							:email="msg.fromAddress"
							deterministic-color
							size="lg"
							class="flex-shrink-0"
							aria-hidden="true"
						/>
						<div class="flex-1 min-w-0">
							<div class="flex items-baseline justify-between gap-3">
								<div>
									<span class="font-medium text-text-primary">
										{{ msg.fromName || msg.fromAddress }}
									</span>
									<span v-if="msg.fromName" class="text-text-tertiary text-sm">
										&lt;{{ msg.fromAddress }}&gt;
									</span>
								</div>
								<div class="flex items-center gap-2 flex-shrink-0">
									<PostboxSenderControls
										v-if="!ownAddresses.has(extractEmailAddress(msg.fromAddress))"
										:mailbox-id="message.mailboxId"
										:from-address="msg.fromAddress"
									/>
									<PostboxTrackerBadge
										v-if="trackerDetection(msg)"
										:detection="trackerDetection(msg)!"
									/>
									<button
										v-if="appIsDark"
										type="button"
										class="text-text-tertiary hover:text-text-primary"
										:title="
											isForcedLight(msg._id)
												? 'Render this message in dark mode'
												: 'Render this message on a light background'
										"
										:aria-label="
											isForcedLight(msg._id)
												? 'Render this message in dark mode'
												: 'Render this message on a light background'
										"
										:aria-pressed="isForcedLight(msg._id)"
										@click="toggleForcedLight(msg._id)"
									>
										<Icon
											:name="isForcedLight(msg._id) ? 'lucide:moon' : 'lucide:sun'"
											class="w-3.5 h-3.5"
										/>
									</button>
									<button
										type="button"
										class="text-xs text-text-tertiary tabular-nums whitespace-nowrap hover:text-text-primary"
										:title="formatDateTime(msg.receivedAt)"
										@click="toggleExpanded(msg._id)"
									>
										{{ relativeReceivedAt(msg.receivedAt) }}
									</button>
								</div>
							</div>
							<p class="text-text-secondary text-xs mt-0.5">
								to {{ msg.toAddresses.join(', ') }}
								<span v-if="msg.ccAddresses.length > 0">
									· cc {{ msg.ccAddresses.join(', ') }}
								</span>
							</p>
							<PostboxUnsubscribeChip
								v-if="msg.unsubscribe"
								class="mt-1.5"
								:message-id="msg._id"
								:mailbox-id="message.mailboxId"
								:unsubscribe="msg.unsubscribe"
							/>
						</div>
					</header>

					<PostboxSchedulingChip
						v-if="showSchedulingChip(msg)"
						:message-id="msg._id"
						:proposed-times="schedulingIntent?.proposedTimes ?? []"
						@use-reply="(t) => openReplyWithBody(msg, t)"
						@dismiss="dismissScheduling(msg._id)"
					/>

					<div
						v-if="msg.spamVerdict === 'spam' || msg.dmarcResult === 'fail'"
						class="my-3 px-3 py-2 rounded bg-warning/10 text-warning text-xs flex items-center gap-2"
					>
						<Icon name="lucide:shield-alert" class="w-4 h-4" />
						<span v-if="msg.spamVerdict === 'spam'">Marked as spam</span>
						<span v-else-if="msg.dmarcResult === 'fail'">Failed DMARC verification</span>
					</div>

					<PostboxSecurityBadge
						v-if="secureClass(msg) !== 'none'"
						:klass="secureClass(msg)"
						:message="msg"
					/>
					<PostboxMessageBody
						v-if="!hideRawBody(msg)"
						:message="msg"
						:force-light="isForcedLight(msg._id)"
						@trackers="onTrackersDetected(msg._id, $event)"
					/>

					<PostboxInviteCard
						v-if="calendarAttachment(msg)"
						:message-id="msg._id"
						:mailbox-id="message.mailboxId"
						:own-email="ownEmail"
					/>

					<section v-if="msg.attachments?.length > 0" class="mt-3">
						<ul class="grid grid-cols-1 sm:grid-cols-2 gap-2">
							<li
								v-for="(att, i) in msg.attachments"
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
									:title="`Preview ${att.filename}`"
									:aria-label="`Preview ${att.filename}`"
									@click="openAttachmentPreview(msg._id, att, msg.attachments)"
								>
									<Icon name="lucide:eye" class="w-4 h-4" />
								</button>
								<button
									type="button"
									class="p-1 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary disabled:opacity-50"
									:title="`Download ${att.filename}`"
									:aria-label="`Download ${att.filename}`"
									:disabled="
										downloadingAttachment === `${msg._id}:${att.partIndex ?? att.filename}`
									"
									@click="handleAttachmentDownload(msg._id, att)"
								>
									<Icon
										:name="
											downloadingAttachment === `${msg._id}:${att.partIndex ?? att.filename}`
												? 'lucide:loader-2'
												: 'lucide:download'
										"
										class="w-4 h-4"
										:class="{
											'animate-spin':
												downloadingAttachment === `${msg._id}:${att.partIndex ?? att.filename}`,
										}"
									/>
								</button>
							</li>
						</ul>
					</section>

					<!-- Progressive disclosure: star + reply stay visible; reply-all
					     and forward reveal on row hover (pointer); the full set is
					     always reachable — keyboard/touch — inside the ⋯ overflow. -->
					<div class="mt-4 flex items-center gap-2">
						<button
							type="button"
							class="btn btn-ghost"
							:class="isMessageStarred(msg) ? 'text-warning' : 'text-text-tertiary'"
							:title="isMessageStarred(msg) ? 'Unstar' : 'Star'"
							:aria-label="isMessageStarred(msg) ? 'Unstar' : 'Star'"
							:aria-pressed="isMessageStarred(msg)"
							@click="toggleMessageStar(msg)"
						>
							<Icon
								name="lucide:star"
								class="w-4 h-4"
								:class="{ 'fill-current': isMessageStarred(msg) }"
							/>
						</button>
						<button type="button" class="btn btn-ghost" @click="openPrimaryReply(msg)">
							<Icon name="lucide:reply" class="w-4 h-4 mr-1.5" />
							Reply
						</button>
						<button
							v-if="hasOtherRecipients(msg)"
							type="button"
							class="btn btn-ghost hidden group-hover:inline-flex"
							@click="openReplyAll(msg)"
						>
							<Icon name="lucide:reply-all" class="w-4 h-4 mr-1.5" />
							Reply all
						</button>
						<button
							type="button"
							class="btn btn-ghost hidden group-hover:inline-flex"
							@click="openForward(msg)"
						>
							<Icon name="lucide:forward" class="w-4 h-4 mr-1.5" />
							Forward
						</button>
						<span class="flex-1" />
						<PostboxOverflowMenu label="More message actions">
							<template #default="{ close }">
								<button
									v-if="hasOtherRecipients(msg)"
									type="button"
									role="menuitem"
									class="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-bg-surface"
									@click="
										openReplyAll(msg);
										close();
									"
								>
									<Icon name="lucide:reply-all" class="w-4 h-4 text-text-tertiary" />
									Reply all
								</button>
								<button
									type="button"
									role="menuitem"
									class="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-bg-surface"
									@click="
										openForward(msg);
										close();
									"
								>
									<Icon name="lucide:forward" class="w-4 h-4 text-text-tertiary" />
									Forward
								</button>
								<button
									type="button"
									role="menuitem"
									class="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-bg-surface"
									@click="
										reportSpamMessage(msg._id);
										close();
									"
								>
									<Icon name="lucide:shield-alert" class="w-4 h-4 text-text-tertiary" />
									Report spam
								</button>
								<button
									type="button"
									role="menuitem"
									class="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-bg-surface"
									@click="
										blockSenderOf(msg._id);
										close();
									"
								>
									<Icon name="lucide:ban" class="w-4 h-4 text-text-tertiary" />
									Block sender
								</button>
							</template>
						</PostboxOverflowMenu>
					</div>
				</section>
			</template>

			<PostboxAiAssist
				v-if="latestMessage && isFeatureEnabled('ai')"
				:message-id="latestMessage._id"
				@use-reply="(t) => latestMessage && openReplyWithBody(latestMessage, t)"
			/>

			<!-- Ask the advisory assistant a question grounded in THIS thread. -->
			<PostboxAskThread
				v-if="latestMessage && isFeatureEnabled('ai')"
				:message-id="latestMessage._id"
			/>

			<!-- Inline reply box pinned under the conversation (r / a / f or the
			     affordance expand it; it collapses back after send/discard). -->
			<PostboxInlineReply
				v-if="latestMessage"
				ref="inlineReplyEl"
				:sender-label="inlineSenderLabel"
				:show-reply-all="hasOtherRecipients(latestMessage)"
				:spec="inlineSpec"
				@expand="(kind) => void (kind === 'reply' ? expandPrimaryReply() : expandInline(kind))"
				@collapse="collapseInline"
			/>
		</div>

		<!-- Keyboard-flow pickers for the open message (h / l / v). -->
		<PostboxSnoozeDialog
			:open="snoozeDialogOpen"
			:hint-text="snoozeHintText"
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
