/**
 * What an opened conversation leads with (BriefPurposeHeader): the one thing
 * it asks of the viewer, taken word for word from the thread brief, then whose
 * turn it is, when it is due and how many other open items stay behind "more".
 * Pure, so every state is unit-testable without the reader.
 *
 *   ask     the top open item: on a personal mailbox the first of "For you",
 *           else of "Waiting on others", else of the unclear ones (the order
 *           a list row's `briefTop` uses, so the row and the reader agree);
 *           on a team surface an item assigned to the viewer comes first.
 *   update  no open item in a brief that read every message: the first
 *           "Latest update" line, acknowledged with Got it.
 *   review  anything else: AI off, no brief yet, a brief still reading, the
 *           viewer hiding AI wording. The host says "Review this conversation"
 *           with the subject, so a missing reading never passes for "nothing
 *           to do".
 *
 * A team surface (a shared mailbox, the Team Inbox) reads the actions-mode
 * view, which carries no latest lines, overview or facts, so it only ever
 * leads with an action or with review.
 */
import type {
	BriefItemView,
	BriefModeView,
	EvidenceView,
	TeamOpenItemsView,
} from '../../../api/convex/mail/interpret/briefShape';
import { latestCiteRef } from '~/utils/threadBriefView';
import type { ReaderStrip } from '~/utils/postboxReaderStrip';

export type PurposeKind = 'ask' | 'update' | 'review';

/**
 * Whose turn the item is. `forYou` on a personal mailbox; on a team surface
 * `forTeam` unless someone holds it (`assignedToYou`, `assignedToOther`).
 */
export type PurposeWho =
	| 'forYou'
	| 'forTeam'
	| 'assignedToYou'
	| 'assignedToOther'
	| 'waitingOnThem'
	| 'needsReview';

export interface PurposeLine {
	item: BriefItemView;
	who: PurposeWho;
}

export interface ThreadPurpose {
	kind: PurposeKind;
	/** The brief's own words for the lead, or null for review (the host's sentence). */
	sentence: string | null;
	/** The item the sentence is (ask only). */
	item: BriefItemView | null;
	who: PurposeWho | null;
	/** The item's resolved deadline (ms), when the brief knows one. */
	due: number | null;
	/** Where the sentence comes from: its cite ref and first quote. */
	source: { ref: string; evidence: EvidenceView } | null;
	/** The other open items that are loaded, each with whose turn it is. */
	others: PurposeLine[];
	/** How many other open items there are in all (the counts, so unloaded pages count too). */
	more: number;
}

export interface PurposeInput {
	/** AI runs here at all (the `ai` flag). */
	isAiOn: boolean;
	/** The viewer shows the brief's wording (`autoSummarize`); absent = on. */
	isBriefShown?: boolean;
	/** A personal mailbox's brief: undefined while loading, null for none. */
	brief?: BriefModeView | null;
	/** A team surface's actions view. Given, the surface is a team one. */
	team?: TeamOpenItemsView | null;
	/** The signed-in user, for "assigned to you". */
	viewerId?: string | null;
}

const REVIEW: ThreadPurpose = {
	kind: 'review',
	sentence: null,
	item: null,
	who: null,
	due: null,
	source: null,
	others: [],
	more: 0,
};

const isOpen = (item: BriefItemView) => item.status === 'open';

function teamWho(item: BriefItemView, viewerId: string | null | undefined): PurposeWho {
	if (!item.assigneeUserId) return 'forTeam';
	return item.assigneeUserId === viewerId ? 'assignedToYou' : 'assignedToOther';
}

/** Every open item in lead order, with whose turn it is. */
function openLines(input: PurposeInput): PurposeLine[] {
	if (input.team !== undefined) {
		const view = input.team;
		if (!view) return [];
		const own = view.forTeam.filter(isOpen).map((item) => ({
			item,
			who: teamWho(item, input.viewerId),
		}));
		// An item the viewer holds leads; the rest keep the brief's order.
		const mine = own.filter((line) => line.who === 'assignedToYou');
		return [
			...mine,
			...own.filter((line) => line.who !== 'assignedToYou'),
			...view.waitingOnOthers
				.filter(isOpen)
				.map((item) => ({ item, who: 'waitingOnThem' as const })),
			...view.unclear.filter(isOpen).map((item) => ({ item, who: 'needsReview' as const })),
		];
	}
	const brief = input.brief;
	if (!brief) return [];
	return [
		...brief.forYou.filter(isOpen).map((item) => ({ item, who: 'forYou' as const })),
		...brief.waitingOnOthers
			.filter(isOpen)
			.map((item) => ({ item, who: 'waitingOnThem' as const })),
		...brief.unclear.filter(isOpen).map((item) => ({ item, who: 'needsReview' as const })),
	];
}

/** Open items in all, from the server's counts (a long thread pages its items). */
function openCount(input: PurposeInput): number {
	if (input.team !== undefined) {
		const c = input.team?.counts;
		return c ? c.forTeam + c.waitingOnOthers + c.unclear : 0;
	}
	const c = input.brief?.counts;
	return c ? c.forYou + c.waitingOnOthers + c.unclear : 0;
}

export function resolveThreadPurpose(input: PurposeInput): ThreadPurpose {
	if (!input.isAiOn || input.isBriefShown === false) return REVIEW;
	const view = input.team !== undefined ? input.team : input.brief;
	if (!view || view.completeness === 'none') return REVIEW;

	const lines = openLines(input);
	const [top, ...others] = lines;
	if (top) {
		const evidence = top.item.evidence[0];
		return {
			kind: 'ask',
			sentence: top.item.text,
			item: top.item,
			who: top.who,
			due: top.item.due?.at ?? null,
			source: evidence ? { ref: top.item.id, evidence } : null,
			others,
			more: Math.max(others.length, openCount(input) - 1),
		};
	}

	// Only information, and only once every message was read: a partial or
	// pending brief may still hold an ask in what it has not read.
	if (input.team !== undefined || input.brief?.completeness !== 'complete') return REVIEW;
	if (openCount(input) > 0) return REVIEW;
	const latest = input.brief.latest?.[0];
	const text = latest?.text.trim();
	if (!latest || !text) return REVIEW;
	const evidence = latest.evidence[0];
	return {
		...REVIEW,
		kind: 'update',
		sentence: text,
		source: evidence ? { ref: latestCiteRef(0), evidence } : null,
	};
}

/**
 * The reader strip once the purpose header leads: what the header already
 * says is left out (the item it names, the latest line it leads with), and a
 * strip with nothing of its own left becomes the slim "Why here? · Details"
 * line.
 */
export function stripBesidePurpose(strip: ReaderStrip, purpose: ThreadPurpose): ReaderStrip {
	if (strip.kind !== 'brief') return strip;
	const shown = purpose.item?.id;
	const owe = strip.owe && strip.owe.id !== shown ? strip.owe : null;
	const waiting = strip.waiting && strip.waiting.id !== shown ? strip.waiting : null;
	const lead = purpose.kind === 'update' && strip.lead?.kind === 'latest' ? null : strip.lead;
	if (!lead && !owe && !waiting) return { kind: 'meta', note: null };
	return { kind: 'brief', lead, owe, waiting };
}
