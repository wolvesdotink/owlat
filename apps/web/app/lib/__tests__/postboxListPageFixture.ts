/**
 * A deterministic Postbox list page, shaped like `mail.mailbox.queries.listMessages`
 * returns it, plus the live updates that page receives. Used by the report-only
 * structural-sharing benchmark (plan item OW-072) and by its fixture-fidelity
 * checks in structuralSharing.perf.test.ts.
 *
 * The shapes follow the server, not a guess:
 * - row fields: the `MAIL_LIST_ROW_KEYS` allowlist plus `RowThreadState`
 *   (apps/api/convex/mail/mailbox/rowThreadState.ts); optional columns are
 *   absent rather than `undefined`, as `toMailListRow` copies them;
 * - snippets: at most 200 code points, as `buildSnippet` truncates them
 *   (apps/api/convex/mail/deliveryPipeline/insert.ts);
 * - page size: 50, the live first page `usePostboxThreads` subscribes to; 500
 *   is the server's clamp (`Math.min(args.limit ?? 50, 500)` in queries.ts);
 * - the page object `{ messages, hasMore, nextCursor }` is what
 *   useConvexQuery's `accept` hands to `shareStructure`, and every update is a
 *   freshly parsed value (JSON round trip), as the Convex client delivers it.
 *
 * Content is synthetic and uses example domains only.
 */
import type { BriefTopRow } from '../../../../api/convex/mail/interpret/briefTop';
import type {
	MailListRow,
	RowThreadState,
} from '../../../../api/convex/mail/mailbox/rowThreadState';

export type ListRow = MailListRow & RowThreadState;
export interface ListPage {
	messages: ListRow[];
	hasMore: boolean;
	nextCursor: string | null;
}

/** The live first page `usePostboxThreads` subscribes to. */
export const LIVE_PAGE_SIZE = 50;
/** The largest page `listMessages` returns, whatever limit is asked for. */
export const SERVER_PAGE_CLAMP = 500;
/** `buildSnippet`'s cap, in code points. */
export const SNIPPET_CODE_POINTS = 200;

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

const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

const WORDS = (
	'thanks for the update on the quarterly report we reviewed the draft and have a few ' +
	'questions about the timeline could you send the revised figures before friday the ' +
	'invoice is attached please confirm the delivery address für das Angebot vielen Dank ' +
	'grüße aus dem Büro meeting moved to thursday agenda below new release notes available'
).split(' ');

const SENDERS = [
	{ name: 'Mara Lindqvist', address: 'mara@example.com', kind: 'person' },
	{ name: 'Jonas Becker', address: 'jonas.becker@example.org', kind: 'person' },
	{ name: 'Priya Natarajan', address: 'priya@example.net', kind: 'person' },
	{ name: 'Léa Moreau', address: 'lea.moreau@example.com', kind: 'person' },
	{ name: 'Owlat Weekly', address: 'newsletter@news.owlat.example', kind: 'newsletter' },
	{ name: 'Build Bot', address: 'noreply@ci.example.com', kind: 'notification' },
	{ name: 'Example Shop', address: 'orders@shop.example.com', kind: 'receipt' },
	{ name: 'Spring Sale', address: 'deals@promo.example.net', kind: 'promotion' },
] as const;

type Rand = () => number;

function pick<T>(rand: Rand, items: readonly T[]): T {
	return items[Math.floor(rand() * items.length)] as T;
}

function convexId(rand: Rand): string {
	let id = '';
	for (let i = 0; i < 32; i++) id += pick(rand, ID_ALPHABET.split(''));
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

type ThreadItemId = NonNullable<BriefTopRow['top']>['itemId'];

function briefTop(rand: Rand, itemId: string): BriefTopRow {
	const forYou = Math.floor(rand() * 3);
	return {
		mode: 'brief',
		forYou,
		waiting: Math.floor(rand() * 2),
		...(forYou > 0
			? {
					top: {
						itemId: itemId as ThreadItemId,
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

/** Context shared by every row of one page: one mailbox, one folder, a label set. */
interface PageContext {
	rand: Rand;
	mailboxId: string;
	folderId: string;
	labelIds: string[];
	/** Threads already on the page, so some rows share one, as real threads do. */
	threadIds: string[];
}

function buildRow(ctx: PageContext, receivedAt: number): ListRow {
	const { rand } = ctx;
	const sender = pick(ctx.rand, SENDERS);
	const isPerson = sender.kind === 'person';
	const reuseThread = ctx.threadIds.length > 0 && rand() < 0.2;
	const threadId = reuseThread ? pick(rand, ctx.threadIds) : convexId(rand);
	if (!reuseThread) ctx.threadIds.push(threadId);
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
	const labelCount = Math.floor(rand() * 3);
	const row: Record<string, unknown> = {
		_id: id,
		_creationTime: receivedAt + rand() * 1000,
		mailboxId: ctx.mailboxId,
		folderId: ctx.folderId,
		threadId,
		fromAddress: sender.address,
		fromName: sender.name,
		toAddresses: ['team@owlat.example', ...(rand() < 0.3 ? ['ops@owlat.example'] : [])],
		ccAddresses: isPerson && rand() < 0.3 ? ['finance@example.com'] : [],
		subject: (reuseThread ? 'Re: ' : '') + sentence(rand, 3, 11),
		snippet: truncateCodePoints(sentence(rand, 30, 60), SNIPPET_CODE_POINTS),
		attachments,
		hasAttachments: attachmentCount > 0,
		flagSeen: rand() < 0.6,
		flagFlagged: rand() < 0.05,
		flagAnswered: isPerson && rand() < 0.15,
		flagDraft: false,
		labelIds: ctx.labelIds.slice(0, labelCount),
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
		row['attachmentIndexing'] = 'indexed';
		row['virusVerdict'] = 'clean';
	}
	if (!isPerson) {
		row['unsubscribe'] = {
			httpUrl: `https://${domain}/unsubscribe/${id.slice(0, 12)}`,
			mailtoUrl: `mailto:unsubscribe@${domain}`,
			oneClick: true,
		};
	}
	if (isPerson && rand() < 0.1) row['replyToAddress'] = `assistant@${domain}`;
	if (rand() < 0.1) row['senderHeuristics'] = { isFirstTimeSender: true };
	if (isPerson && rand() < 0.03) {
		row['inboundSignatureInfo'] = { isSigned: true, isSignatureValid: true, keySource: 'wkd' };
	}
	// Thread state, joined by attachThreadState.
	row['category'] = sender.kind;
	if (isPerson && rand() < 0.7) row['briefTop'] = briefTop(rand, convexId(rand));
	if (rand() < 0.8)
		row['placement'] = isPerson ? pick(rand, ['needs_me', 'today'] as const) : 'updates';
	if (isPerson && rand() < 0.08) {
		row['followUp'] = { remindAt: receivedAt + 86_400_000 * 3, watched: true };
	}
	return row as unknown as ListRow;
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

export interface ListUpdate {
	name: string;
	/** What the subscription delivered before. */
	prev: ListPage;
	/** The update, freshly parsed. */
	next: ListPage;
	/** How many rows of `prev` the reconciled page should keep by identity. */
	keptRows: number;
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
		threadIds: [],
	};
	const rowAt = (i: number) => buildRow(ctx, NEWEST_ARRIVAL - i * ARRIVAL_GAP_MS);
	// One row past each end, for the arrival and the backfill after an archive.
	const all = Array.from({ length: size + 10 }, (_, i) => rowAt(i));
	const arrival = buildRow(ctx, NEWEST_ARRIVAL + ARRIVAL_GAP_MS);
	const prev: ListPage = {
		messages: all.slice(0, size),
		hasMore: true,
		nextCursor: cursorAfter(ctx.rand),
	};
	const middle = Math.floor(size / 2);

	const markRead = wireCopy(prev);
	const target = markRead.messages[middle] as ListRow;
	markRead.messages[middle] = { ...target, flagSeen: !target.flagSeen };

	const briefLine = wireCopy(prev);
	const briefIndex = briefLine.messages.findIndex((row) => row.briefTop !== undefined);
	const briefRow = briefLine.messages[briefIndex] as ListRow;
	briefLine.messages[briefIndex] = {
		...briefRow,
		briefTop: {
			...(briefRow.briefTop as BriefTopRow),
			latest: { en: 'Moved to Thursday.', de: 'Auf Donnerstag verschoben.' },
		},
	};

	const archived = Math.min(10, size);
	const archiveStart = Math.max(0, middle - archived / 2);
	return [
		{ name: 'unchanged re-push', prev, next: wireCopy(prev), keptRows: size },
		{ name: 'one row marked read', prev, next: markRead, keptRows: size - 1 },
		{ name: 'brief line updated on one thread', prev, next: briefLine, keptRows: size - 1 },
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
					...all.slice(size, size + archived),
				],
				hasMore: true,
				nextCursor: cursorAfter(ctx.rand),
			}),
			keptRows: size - archived,
		},
	];
}
