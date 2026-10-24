/**
 * A deterministic Postbox list page, shaped like `mail.mailbox.queries.listMessages`
 * returns it, plus the live updates that page receives. Used by the report-only
 * structural-sharing benchmark (plan item OW-072).
 *
 * The fixture is checked against the server by executable contracts, not by
 * reading source text:
 * - apps/api/convex/mail/__tests__/perfListFixtureContract.test.ts runs every
 *   row through the real `toMailListRow` projection, compares the fixture's
 *   declared row type with the query's return type at compile time, caps
 *   snippets with the real `buildSnippet`, and pages real rows through
 *   `listMessages` to pin LIVE_PAGE_SIZE (no limit) and SERVER_PAGE_CLAMP;
 * - apps/web/app/lib/__tests__/structuralSharing.perf.test.ts drives
 *   `usePostboxThreads` to pin the limit the client asks for, and checks the
 *   thread-state invariants and that each update takes the path it is named for.
 *
 * Shape notes, following the server:
 * - optional columns are absent rather than `undefined`, as `toMailListRow`
 *   copies only present keys;
 * - thread state (`attachThreadState`) is read once per thread, so every row of
 *   a thread carries the same category, brief, placement, mute and follow-up
 *   timing; only `followUp.watched` differs, true on the watched message alone;
 * - the page object `{ messages, hasMore, nextCursor }` is what useConvexQuery's
 *   `accept` hands to `shareStructure`, and every update is a freshly parsed
 *   value (JSON round trip), as the Convex client delivers it.
 *
 * Types are declared here structurally (ids as plain strings) because a root
 * script may not import from apps/; the API contract test holds them to the
 * real wire type. Content is synthetic and uses example domains only.
 */

/** The live first page `usePostboxThreads` subscribes to, and `listMessages`' default. */
export const LIVE_PAGE_SIZE = 50;
/** The largest page `listMessages` returns, whatever limit is asked for. */
export const SERVER_PAGE_CLAMP = 500;
/** `buildSnippet`'s cap, in code points. */
export const SNIPPET_CODE_POINTS = 200;

export interface ListRowBriefTop {
	mode: 'brief' | 'actions';
	forYou: number;
	waiting: number;
	top?: {
		itemId: string;
		bucket?: 'forUs' | 'waitingOnOthers';
		responsibility: 'us' | 'them' | 'unclear';
		text: { en: string; de: string };
		dueAt?: number;
	};
	latest?: { en: string; de: string };
	gist?: { text: string; factQuote?: string };
	isReplyNeeded: boolean;
}

/** Every key a list row can carry: `MAIL_LIST_ROW_KEYS` plus `RowThreadState`. */
export interface ListRow {
	_id: string;
	_creationTime: number;
	mailboxId: string;
	folderId: string;
	threadId: string;
	fromAddress: string;
	fromName?: string;
	toAddresses: string[];
	ccAddresses: string[];
	replyToAddress?: string;
	subject: string;
	snippet: string;
	attachments: Array<{
		filename: string;
		contentType: string;
		size: number;
		contentId?: string;
		partIndex: string;
	}>;
	hasAttachments: boolean;
	attachmentIndexing?: string;
	flagSeen: boolean;
	flagFlagged: boolean;
	flagAnswered: boolean;
	flagDraft: boolean;
	labelIds: string[];
	trashedAt?: number;
	snoozedUntil?: number;
	isSnoozeUntilReply?: boolean;
	pinnedSection?: string;
	unsubscribe?: { httpUrl?: string; mailtoUrl?: string; oneClick: boolean };
	receivedAt: number;
	spamVerdict?: string;
	virusVerdict?: string;
	spfResult?: string;
	dkimResult?: string;
	dmarcResult?: string;
	dmarcPolicy?: string;
	envelopeFromDomain?: string;
	dkimSigningDomain?: string;
	dmarcOverride?: string;
	arcSealer?: string;
	senderHeuristics?: {
		isFromDomainSpoofed?: boolean;
		isReplyToMismatch?: boolean;
		isFirstTimeSender?: boolean;
		lookalikeOfContactDomain?: string;
	};
	inboundEncryptionInfo?:
		| {
				isSealed: true;
				isDecrypted: true;
				cipherSuite: string;
				isSignatureValid: boolean;
				signerFingerprint?: string;
				signerInstance?: string;
		  }
		| { isSealed: true; isDecrypted: false };
	inboundSignatureInfo?: {
		isSigned: true;
		isSignatureValid: boolean;
		signerFingerprint?: string;
		keySource: 'pinned' | 'wkd' | 'manifest' | 'not_found';
		failure?: string;
		scope?: 'clearsigned' | 'mime';
	};
	// Thread state, joined in by attachThreadState.
	followUp?: { remindAt: number; dueAt?: number; watched: boolean };
	mutedAt?: number;
	pinnedAt?: number;
	snoozeReturnedAt?: number;
	category?: string;
	briefTop?: ListRowBriefTop;
	placement?: string;
}

/** The thread-state keys of a row, as `attachThreadState` joins them. */
export const THREAD_STATE_KEYS = [
	'followUp',
	'mutedAt',
	'pinnedAt',
	'snoozeReturnedAt',
	'category',
	'briefTop',
	'placement',
] as const;

export interface ListPage {
	messages: ListRow[];
	hasMore: boolean;
	nextCursor: string | null;
}

/** mulberry32: a small seeded PRNG, so every run builds the same page. */
function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'.split('');

const WORDS = (
	'thanks for the update on the quarterly report we reviewed the draft and have a few ' +
	'questions about the timeline could you send the revised figures before friday the ' +
	'invoice is attached please confirm the delivery address für das Angebot vielen Dank ' +
	'grüße aus dem Büro meeting moved to thursday agenda below new release notes available'
).split(' ');

type SenderKind = 'person' | 'newsletter' | 'notification' | 'receipt' | 'promotion';

const SENDERS: ReadonlyArray<{ name: string; address: string; kind: SenderKind }> = [
	{ name: 'Mara Lindqvist', address: 'mara@example.com', kind: 'person' },
	{ name: 'Jonas Becker', address: 'jonas.becker@example.org', kind: 'person' },
	{ name: 'Priya Natarajan', address: 'priya@example.net', kind: 'person' },
	{ name: 'Léa Moreau', address: 'lea.moreau@example.com', kind: 'person' },
	{ name: 'Owlat Weekly', address: 'newsletter@news.owlat.example', kind: 'newsletter' },
	{ name: 'Build Bot', address: 'noreply@ci.example.com', kind: 'notification' },
	{ name: 'Example Shop', address: 'orders@shop.example.com', kind: 'receipt' },
	{ name: 'Spring Sale', address: 'deals@promo.example.net', kind: 'promotion' },
];

type Rand = () => number;

function pick<T>(rand: Rand, items: readonly T[]): T {
	return items[Math.floor(rand() * items.length)] as T;
}

function convexId(rand: Rand): string {
	let id = '';
	for (let i = 0; i < 32; i++) id += pick(rand, ID_ALPHABET);
	return id;
}

function sentence(rand: Rand, minWords: number, maxWords: number): string {
	const count = minWords + Math.floor(rand() * (maxWords - minWords + 1));
	const words: string[] = [];
	for (let i = 0; i < count; i++) words.push(pick(rand, WORDS));
	const text = words.join(' ');
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Truncate to whole code points, as the server's snippet does. */
function truncateCodePoints(text: string, max: number): string {
	const points = Array.from(text);
	return points.length <= max ? text : points.slice(0, max).join('');
}

function briefTop(rand: Rand): ListRowBriefTop {
	const forYou = Math.floor(rand() * 3);
	return {
		mode: 'brief',
		forYou,
		waiting: Math.floor(rand() * 2),
		...(forYou > 0
			? {
					top: {
						itemId: convexId(rand),
						bucket: 'forUs' as const,
						responsibility: 'us' as const,
						text: { en: sentence(rand, 5, 12), de: sentence(rand, 5, 12) },
						...(rand() < 0.4 ? { dueAt: 1_790_000_000_000 + Math.floor(rand() * 1e9) } : {}),
					},
				}
			: {}),
		latest: { en: sentence(rand, 8, 18), de: sentence(rand, 8, 18) },
		isReplyNeeded: forYou > 0,
	};
}

/** What `attachThreadState` reads off one thread document. */
interface ThreadState {
	id: string;
	kind: SenderKind;
	category: SenderKind;
	briefTop?: ListRowBriefTop;
	placement?: string;
	mutedAt?: number;
	/** The follow-up watch: one watched message, a reminder time. */
	followUp?: { remindAt: number; dueAt?: number; messageId?: string };
}

function newThread(rand: Rand, kind: SenderKind, receivedAt: number): ThreadState {
	const isPerson = kind === 'person';
	const state: ThreadState = { id: convexId(rand), kind, category: kind };
	if (isPerson && rand() < 0.7) state.briefTop = briefTop(rand);
	if (rand() < 0.8) state.placement = isPerson ? pick(rand, ['needs_me', 'today']) : 'updates';
	if (!isPerson && rand() < 0.05) state.mutedAt = receivedAt - 86_400_000;
	if (isPerson && rand() < 0.1) state.followUp = { remindAt: receivedAt + 3 * 86_400_000 };
	return state;
}

/** The thread-state part of a row, as attachThreadState spreads it in. */
function threadStateOf(thread: ThreadState, messageId: string): Partial<ListRow> {
	// One message per thread carries the watch: the first of its rows built.
	if (thread.followUp && thread.followUp.messageId === undefined) {
		thread.followUp.messageId = messageId;
	}
	return {
		...(thread.followUp
			? {
					followUp: {
						remindAt: thread.followUp.remindAt,
						...(thread.followUp.dueAt !== undefined ? { dueAt: thread.followUp.dueAt } : {}),
						watched: thread.followUp.messageId === messageId,
					},
				}
			: {}),
		...(thread.mutedAt !== undefined ? { mutedAt: thread.mutedAt } : {}),
		category: thread.category,
		...(thread.briefTop ? { briefTop: structuredClone(thread.briefTop) } : {}),
		...(thread.placement !== undefined ? { placement: thread.placement } : {}),
	};
}

/** Context shared by every row of one page: one mailbox, one folder, a label set. */
interface PageContext {
	rand: Rand;
	mailboxId: string;
	folderId: string;
	labelIds: string[];
	/** Threads already on the page, so some rows share one, as real threads do. */
	threads: ThreadState[];
}

function buildRow(ctx: PageContext, receivedAt: number): ListRow {
	const { rand } = ctx;
	const reuse = ctx.threads.length > 0 && rand() < 0.2;
	const thread = reuse
		? pick(rand, ctx.threads)
		: newThread(rand, pick(rand, SENDERS).kind, receivedAt);
	if (!reuse) ctx.threads.push(thread);
	// A reply in a thread comes from a sender of the same kind.
	const sender = pick(
		rand,
		SENDERS.filter((s) => s.kind === thread.kind)
	);
	const isPerson = sender.kind === 'person';
	const id = convexId(rand);
	const attachmentCount =
		sender.kind === 'receipt' ? 1 : isPerson && rand() < 0.25 ? 1 + Math.floor(rand() * 2) : 0;
	const attachments = Array.from({ length: attachmentCount }, (_, i) => ({
		filename:
			sender.kind === 'receipt' ? `invoice-${Math.floor(rand() * 1e6)}.pdf` : `notes-${i + 1}.pdf`,
		contentType: 'application/pdf',
		size: 20_000 + Math.floor(rand() * 900_000),
		partIndex: String(i + 2),
	}));
	const domain = sender.address.split('@')[1] as string;
	const row: ListRow = {
		_id: id,
		_creationTime: receivedAt + rand() * 1000,
		mailboxId: ctx.mailboxId,
		folderId: ctx.folderId,
		threadId: thread.id,
		fromAddress: sender.address,
		fromName: sender.name,
		toAddresses: ['team@owlat.example', ...(rand() < 0.3 ? ['ops@owlat.example'] : [])],
		ccAddresses: isPerson && rand() < 0.3 ? ['finance@example.com'] : [],
		subject: (reuse ? 'Re: ' : '') + sentence(rand, 3, 11),
		snippet: truncateCodePoints(sentence(rand, 30, 60), SNIPPET_CODE_POINTS),
		attachments,
		hasAttachments: attachmentCount > 0,
		flagSeen: rand() < 0.6,
		flagFlagged: rand() < 0.05,
		flagAnswered: isPerson && rand() < 0.15,
		flagDraft: false,
		labelIds: ctx.labelIds.slice(0, Math.floor(rand() * 3)),
		receivedAt,
		spamVerdict: 'ham',
		spfResult: 'pass',
		dkimResult: 'pass',
		dmarcResult: 'pass',
		dmarcPolicy: rand() < 0.5 ? 'reject' : 'none',
		envelopeFromDomain: domain,
		dkimSigningDomain: domain,
	};
	if (attachmentCount > 0) {
		row.attachmentIndexing = 'indexed';
		row.virusVerdict = 'clean';
	}
	if (!isPerson) {
		row.unsubscribe = {
			httpUrl: `https://${domain}/unsubscribe/${id.slice(0, 12)}`,
			mailtoUrl: `mailto:unsubscribe@${domain}`,
			oneClick: true,
		};
	}
	if (isPerson && rand() < 0.1) row.replyToAddress = `assistant@${domain}`;
	if (rand() < 0.1) row.senderHeuristics = { isFirstTimeSender: true };
	if (isPerson && rand() < 0.03) {
		row.inboundSignatureInfo = { isSigned: true, isSignatureValid: true, keySource: 'wkd' };
	}
	return { ...row, ...threadStateOf(thread, id) };
}

/** The newest row's arrival time; each older row arrived one gap earlier. */
const NEWEST_ARRIVAL = 1_792_000_000_000;
const ARRIVAL_GAP_MS = 7 * 60_000;

function cursorAfter(rand: Rand): string {
	// Convex continue cursors are opaque strings of about this length.
	return Array.from({ length: 4 }, () => convexId(rand)).join('');
}

/** A fresh copy of a page, as the Convex client delivers every update. */
export function wireCopy(page: ListPage): ListPage {
	return JSON.parse(JSON.stringify(page)) as ListPage;
}

/** UTF-8 size of a value's JSON, as it travels. */
export function jsonBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).length;
}

export interface ListUpdate {
	name: string;
	/** What the subscription delivered before. */
	prev: ListPage;
	/** The update, freshly parsed. */
	next: ListPage;
	/** How many rows of `prev` the reconciled page should keep by identity. */
	keptRows: number;
}

/** The thread with a brief and the most rows on the page: its brief update touches them all. */
function busiestBriefThread(page: ListPage): string {
	const counts = new Map<string, number>();
	for (const row of page.messages) {
		if (row.briefTop) counts.set(row.threadId, (counts.get(row.threadId) ?? 0) + 1);
	}
	let best: string | undefined;
	for (const [threadId, count] of counts) {
		if (best === undefined || count > (counts.get(best) ?? 0)) best = threadId;
	}
	if (best === undefined) throw new Error('no row on the page carries a brief');
	return best;
}

/**
 * The live updates a list page receives, each from a real cause, for a page of
 * `size` rows (newest first, as the default sort returns them).
 */
export function listUpdates(size: number, seed = 0x0f72): ListUpdate[] {
	const ctx: PageContext = {
		rand: prng(seed),
		mailboxId: convexId(prng(seed + 1)),
		folderId: convexId(prng(seed + 2)),
		labelIds: Array.from({ length: 6 }, (_, i) => convexId(prng(seed + 10 + i))),
		threads: [],
	};
	// Built oldest first, in arrival order, then reversed into the newest-first
	// page order. Ten extra older rows back-fill the page after the archive.
	const archived = Math.min(10, size);
	const older = Array.from({ length: archived }, (_, i) =>
		buildRow(ctx, NEWEST_ARRIVAL - (size + archived - 1 - i) * ARRIVAL_GAP_MS)
	).reverse();
	const pageRows = Array.from({ length: size }, (_, i) =>
		buildRow(ctx, NEWEST_ARRIVAL - (size - 1 - i) * ARRIVAL_GAP_MS)
	).reverse();
	const arrival = buildRow(ctx, NEWEST_ARRIVAL + ARRIVAL_GAP_MS);
	const prev: ListPage = { messages: pageRows, hasMore: true, nextCursor: cursorAfter(ctx.rand) };
	const middle = Math.floor(size / 2);

	// Opening an unread row: the first unread one from the middle of the page on.
	const markRead = wireCopy(prev);
	const unread = markRead.messages.findIndex((row, i) => i >= middle && !row.flagSeen);
	if (unread < 0) throw new Error('no unread row in the second half of the page');
	markRead.messages[unread] = { ...(markRead.messages[unread] as ListRow), flagSeen: true };

	// A new brief line is a thread-level change: every row of the thread shows it.
	const briefThread = busiestBriefThread(prev);
	const briefLine = wireCopy(prev);
	let briefRows = 0;
	briefLine.messages = briefLine.messages.map((row) => {
		if (row.threadId !== briefThread || !row.briefTop) return row;
		briefRows += 1;
		const latest = { en: 'Moved to Thursday.', de: 'Auf Donnerstag verschoben.' };
		return { ...row, briefTop: { ...row.briefTop, latest } };
	});

	const archiveStart = Math.max(0, middle - archived / 2);
	return [
		{ name: 'unchanged re-push', prev, next: wireCopy(prev), keptRows: size },
		{ name: 'one row marked read', prev, next: markRead, keptRows: size - 1 },
		{
			name: 'brief line updated on one thread',
			prev,
			next: briefLine,
			keptRows: size - briefRows,
		},
		{
			name: 'new arrival at the top',
			prev,
			next: wireCopy({
				messages: [arrival, ...prev.messages.slice(0, size - 1)],
				hasMore: true,
				nextCursor: cursorAfter(ctx.rand),
			}),
			keptRows: size - 1,
		},
		{
			name: `${archived} rows archived`,
			prev,
			next: wireCopy({
				messages: [
					...prev.messages.slice(0, archiveStart),
					...prev.messages.slice(archiveStart + archived),
					...older,
				],
				hasMore: true,
				nextCursor: cursorAfter(ctx.rand),
			}),
			keptRows: size - archived,
		},
	];
}
