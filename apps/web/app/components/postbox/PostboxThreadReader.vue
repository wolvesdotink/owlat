<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { extractAttachmentAt } from '@owlat/shared/mailMime';
import { escapeHtmlWithBreaks } from '@owlat/shared/html';
import { formatDateTime } from '~/utils/formatters';
import type { PostboxPendingCompose } from '~/utils/postboxShortcuts';
import {
	classifySecureMessage,
	isEncryptedClass,
	type SecureMessageClass,
} from '@owlat/shared/secureMessage';
import type { TrackerDetection } from '@owlat/shared/postboxTrackers';

const props = defineProps<{
	message: {
		_id: string;
		mailboxId: string;
		threadId?: string;
		fromAddress: string;
		fromName?: string;
		toAddresses: string[];
		ccAddresses: string[];
		subject: string;
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
	};
	// Auto-advance context (folder view only; the search preview passes
	// neither and keeps its stay-put behavior). `advanceIds` is the list's
	// current visual order (optimistic-hide filtered), `folderRole` the
	// route segment used to build /dashboard/postbox/<folder>/<id> links.
	advanceIds?: string[];
	folderRole?: string;
}>();

const stack = usePostboxComposerStack();
const { isEnabled: isFeatureEnabled } = useFeatureFlag();

// The mailbox's own addresses (canonical + active aliases) — excluded from the
// Cc set on Reply-All so the user never adds themselves.
const ownIdentitiesQuery = useConvexQuery(
	api.mail.identities.listForOwnedMailbox,
	() => ({ mailboxId: props.message.mailboxId as Id<'mailboxes'> })
);

/** Strip "Name <addr>" framing and lowercase, for dedupe/exclusion compares. */
function canonicalEmail(raw: string): string {
	const m = raw.match(/<([^>]+)>/);
	return (m?.[1] ?? raw).trim().toLowerCase();
}

const ownAddresses = computed(
	() =>
		new Set(
			((ownIdentitiesQuery.data.value as string[] | undefined) ?? []).map(canonicalEmail)
		)
);
const ownEmail = computed(() => (ownIdentitiesQuery.data.value as string[] | undefined)?.[0]);

// PGP/S-MIME structure per message (detection only — see PostboxSecurityBadge),
// classified once per thread change rather than on every template re-render.
const secureClassMap = computed(() => {
	const map = new Map<string, SecureMessageClass>();
	for (const m of allMessages.value) {
		map.set(m._id, classifySecureMessage({ attachments: m.attachments, textBody: m.textBodyInline }));
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
			a.contentType.toLowerCase().includes('calendar') ||
			a.filename.toLowerCase().endsWith('.ics')
	);
}

const messageId = computed(() => props.message._id as Id<'mailMessages'>);
const { data: threadData, isLoading } = useConvexQuery(
	api.mail.mailbox.listThreadMessages,
	() => ({ messageId: messageId.value })
);

const allMessages = computed(() => threadData.value?.messages ?? [props.message]);
const latestMessage = computed(() => allMessages.value[allMessages.value.length - 1]);
const labelMap = computed(() => {
	const map = new Map<string, { _id: string; name: string; color?: string }>();
	for (const l of threadData.value?.labels ?? []) map.set(l._id, l);
	return map;
});
const threadLabels = computed(() => threadData.value?.thread?.labelIds ?? []);

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
 * Resolve the original body for quoting. Messages over ~64KB store their body
 * in blob storage with empty inline fields, so Reply/Forward would quote an
 * empty original — fetch the full body in that case (the same source
 * PostboxMessageBody renders from). Falls back to the row on any error so the
 * composer always opens.
 */
async function resolveBodyFields(t: ReplyForwardSource): Promise<ReplyForwardSource> {
	if (t.htmlBodyInline || t.textBodyInline) return t;
	try {
		const data = await requireConvex().query(api.mail.mailbox.getMessageBody, {
			messageId: t._id as Id<'mailMessages'>,
		});
		if (!data) return t;
		let html = data.htmlInline ?? undefined;
		let text = data.textInline ?? undefined;
		if (!html && data.htmlUrl) html = await (await fetch(data.htmlUrl)).text();
		else if (!text && data.textUrl) text = await (await fetch(data.textUrl)).text();
		return { ...t, htmlBodyInline: html, textBodyInline: text };
	} catch {
		return t;
	}
}

async function openReply(replyTo?: ReplyForwardSource) {
	const target = await resolveBodyFields(replyTo ?? props.message);
	stack.open({
		mailboxId: props.message.mailboxId as Id<'mailboxes'>,
		inReplyToMessageId: target._id as Id<'mailMessages'>,
		prefillTo: [target.fromAddress],
		prefillSubject: target.subject.match(/^re\s*:\s*/i)
			? target.subject
			: `Re: ${target.subject}`,
		prefillBodyHtml: buildQuotedReply(target),
	});
}

async function openReplyAll(replyTo?: ReplyForwardSource) {
	const target = await resolveBodyFields(replyTo ?? props.message);
	const seen = new Set<string>([canonicalEmail(target.fromAddress), ...ownAddresses.value]);
	const cc: string[] = [];
	for (const addr of [...target.toAddresses, ...target.ccAddresses]) {
		const canon = canonicalEmail(addr);
		if (!canon || seen.has(canon)) continue;
		seen.add(canon);
		cc.push(addr);
	}
	stack.open({
		mailboxId: props.message.mailboxId as Id<'mailboxes'>,
		inReplyToMessageId: target._id as Id<'mailMessages'>,
		prefillTo: [target.fromAddress],
		prefillCc: cc,
		prefillSubject: target.subject.match(/^re\s*:\s*/i)
			? target.subject
			: `Re: ${target.subject}`,
		prefillBodyHtml: buildQuotedReply(target),
	});
}

/** Whether Reply-All would add anyone beyond a plain Reply (extra To/Cc). */
function hasOtherRecipients(msg: { fromAddress: string; toAddresses: string[]; ccAddresses: string[] }) {
	const seen = new Set<string>([canonicalEmail(msg.fromAddress), ...ownAddresses.value]);
	return [...msg.toAddresses, ...msg.ccAddresses].some((a) => {
		const c = canonicalEmail(a);
		return c.length > 0 && !seen.has(c);
	});
}

/** Open a reply seeded with an AI-suggested body (above the quoted original). */
async function openReplyWithBody(replyTarget: ReplyForwardSource, bodyText: string) {
	const target = await resolveBodyFields(replyTarget);
	stack.open({
		mailboxId: props.message.mailboxId as Id<'mailboxes'>,
		inReplyToMessageId: target._id as Id<'mailMessages'>,
		prefillTo: [target.fromAddress],
		prefillSubject: target.subject.match(/^re\s*:\s*/i)
			? target.subject
			: `Re: ${target.subject}`,
		prefillBodyHtml: `<p>${escapeHtmlWithBreaks(bodyText)}</p>${buildQuotedReply(target)}`,
	});
}

async function openForward(msg?: ReplyForwardSource) {
	const target = await resolveBodyFields(msg ?? props.message);
	stack.open({
		mailboxId: props.message.mailboxId as Id<'mailboxes'>,
		prefillSubject: target.subject.match(/^fwd?\s*:\s*/i)
			? target.subject
			: `Fwd: ${target.subject}`,
		prefillBodyHtml: buildForwardedBody(target),
		forwardAttachmentsFromMessageId: target._id as Id<'mailMessages'>,
	});
}

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
		if (open === 'reply') void openReply();
		else if (open === 'replyAll') void openReplyAll();
		else if (open === 'forward') void openForward();
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
const { autoAdvance } = usePostboxSettings();

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
async function applyLabelToOpenMessage(labelId: Id<'mailLabels'>) {
	labelDialogOpen.value = false;
	await setLabelOnMessage(messageId.value, labelId, true);
}
async function moveOpenMessageTo(targetFolderId: Id<'mailFolders'>) {
	moveDialogOpen.value = false;
	const result = await moveOp.run({ messageIds: [messageId.value], targetFolderId });
	registerTriageUndo('Moved', result);
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
			void openReply(latestMessage.value);
			break;
		case 'replyAll':
			void openReplyAll(latestMessage.value);
			break;
		case 'forward':
			void openForward(latestMessage.value);
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
	}
}

onMounted(() => window.addEventListener('keydown', onReaderShortcut));
onBeforeUnmount(() => window.removeEventListener('keydown', onReaderShortcut));

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
	<article class="p-6 max-w-4xl mx-auto">
		<header class="mb-4">
			<h1 class="text-2xl font-semibold text-text-primary">
				{{ message.subject || '(no subject)' }}
			</h1>
			<div
				v-if="threadLabels.length > 0"
				class="mt-2 flex flex-wrap items-center gap-1.5"
			>
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
							<span class="font-medium">{{ msg.fromName || msg.fromAddress }}</span>
							<span class="text-text-tertiary mx-1.5">·</span>
							<span class="text-text-tertiary">{{ msg.subject }}</span>
						</p>
					</div>
					<span class="text-xs text-text-tertiary flex-shrink-0">
						{{ formatDateTime(msg.receivedAt) }}
					</span>
				</button>

				<!-- Expanded message -->
				<section
					v-else
					class="border border-border-subtle rounded bg-bg-surface px-4 py-3"
				>
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
									<PostboxTrackerBadge
										v-if="trackerDetection(msg)"
										:detection="trackerDetection(msg)!"
									/>
									<button
										v-if="appIsDark"
										type="button"
										class="text-text-tertiary hover:text-text-primary"
										:title="isForcedLight(msg._id) ? 'Render this message in dark mode' : 'Render this message on a light background'"
										:aria-label="isForcedLight(msg._id) ? 'Render this message in dark mode' : 'Render this message on a light background'"
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
										class="text-xs text-text-tertiary hover:text-text-primary"
										@click="toggleExpanded(msg._id)"
									>
										{{ formatDateTime(msg.receivedAt) }}
									</button>
								</div>
							</div>
							<p class="text-text-secondary text-xs mt-0.5">
								to {{ msg.toAddresses.join(', ') }}
								<span v-if="msg.ccAddresses.length > 0">
									· cc {{ msg.ccAddresses.join(', ') }}
								</span>
							</p>
						</div>
					</header>

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
									:disabled="downloadingAttachment === `${msg._id}:${att.partIndex ?? att.filename}`"
									@click="handleAttachmentDownload(msg._id, att)"
								>
									<Icon
										:name="downloadingAttachment === `${msg._id}:${att.partIndex ?? att.filename}` ? 'lucide:loader-2' : 'lucide:download'"
										class="w-4 h-4"
										:class="{ 'animate-spin': downloadingAttachment === `${msg._id}:${att.partIndex ?? att.filename}` }"
									/>
								</button>
							</li>
						</ul>
					</section>

					<div class="mt-4 flex items-center gap-2">
						<button
							type="button"
							class="btn btn-ghost"
							@click="openReply(msg)"
						>
							<Icon name="lucide:reply" class="w-4 h-4 mr-1.5" />
							Reply
						</button>
						<button
							v-if="hasOtherRecipients(msg)"
							type="button"
							class="btn btn-ghost"
							@click="openReplyAll(msg)"
						>
							<Icon name="lucide:reply-all" class="w-4 h-4 mr-1.5" />
							Reply all
						</button>
						<button
							type="button"
							class="btn btn-ghost"
							@click="openForward(msg)"
						>
							<Icon name="lucide:forward" class="w-4 h-4 mr-1.5" />
							Forward
						</button>
						<span class="flex-1" />
						<button
							type="button"
							class="btn btn-ghost text-text-tertiary"
							title="Report spam"
							aria-label="Report spam"
							@click="reportSpamMessage(msg._id)"
						>
							<Icon name="lucide:shield-alert" class="w-4 h-4" />
						</button>
						<button
							type="button"
							class="btn btn-ghost text-text-tertiary"
							title="Block sender"
							aria-label="Block sender"
							@click="blockSenderOf(msg._id)"
						>
							<Icon name="lucide:ban" class="w-4 h-4" />
						</button>
					</div>
				</section>
			</template>

			<PostboxAiAssist
				v-if="latestMessage && isFeatureEnabled('ai')"
				:message-id="latestMessage._id"
				@use-reply="(t) => latestMessage && openReplyWithBody(latestMessage, t)"
			/>
		</div>

		<!-- Keyboard-flow pickers for the open message (h / l / v). -->
		<PostboxSnoozeDialog
			:open="snoozeDialogOpen"
			@update:open="snoozeDialogOpen = $event"
			@confirm="snoozeOpenMessage"
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
