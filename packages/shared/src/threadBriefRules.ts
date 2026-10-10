/**
 * Thread brief: the pure item rules (SPEC §3, plan §5) over the vocabulary in
 * `threadBrief.ts`: the state a user sees, the reaction an item offers, the
 * "For you" order, which proposals the verifier checks, and the reducer's
 * lifecycle edges.
 *
 * Pure and import-free apart from the vocabulary: safe in the Convex V8
 * runtime, in Node actions and in the browser.
 */

import type {
	ActivityActor,
	ItemCompletion,
	ItemConsequenceKind,
	ItemDisposition,
	ItemFacet,
	ItemIntent,
	ItemReaction,
	ItemResponsibility,
	ItemStateKey,
	ItemStatus,
	ResponseStance,
} from './threadBrief';

// ── Item state (what the user sees) ────────────────────────────────────────

export interface ItemStateInput {
	status: ItemStatus;
	disposition: ItemDisposition;
	completion?: ItemCompletion | null;
}

/**
 * Map an item's stored status, disposition and completion to the one state the
 * user sees. `addressedInDraft` is passed in by the caller that holds the
 * draft's coverage; it only applies to an open item.
 */
export function itemStateKey(
	item: ItemStateInput,
	options: { addressedInDraft?: boolean } = {}
): ItemStateKey {
	switch (item.status) {
		case 'untracked':
			return 'notTracked';
		case 'superseded':
			return 'replaced';
		case 'declined':
			return 'declined';
		case 'done':
			if (item.completion === 'asserted') return 'markedDoneByYou';
			if (item.completion === 'reported') return 'reportedDone';
			return 'done';
		case 'open':
			if (options.addressedInDraft) return 'addressedInDraft';
			if (
				item.disposition === 'answered' ||
				item.disposition === 'accepted' ||
				item.disposition === 'deferred'
			) {
				return 'answeredStillToDo';
			}
			return 'open';
	}
}

// ── Reactions ──────────────────────────────────────────────────────────────

export interface ReactionOptions {
	/** The thread needs no reply (informational mail that still carries items). */
	noReplyNeeded?: boolean;
}

interface ReactionChoice {
	primary: ItemReaction;
	also: readonly ItemReaction[];
}

/** Plan §5's table: one primary reaction per intent + facets, the rest in the ⋯ menu. */
function chooseReactions(
	intent: ItemIntent,
	facets: readonly ItemFacet[],
	responsibility: ItemResponsibility,
	options: ReactionOptions
): ReactionChoice {
	const has = (facet: ItemFacet) => facets.includes(facet);
	if (responsibility === 'them') {
		return { primary: 'nudge', also: ['markReceived', 'untrack'] };
	}
	switch (intent) {
		case 'promise':
			return { primary: 'markDone', also: ['replyWithUpdate', 'remind'] };
		case 'question':
			return { primary: 'reply', also: ['remind', 'notARequest'] };
		case 'decision':
			return { primary: 'replyWithStance', also: ['remind', 'assign'] };
		case 'request':
			if (has('payment') && options.noReplyNeeded) {
				return { primary: 'markPaid', also: ['remind', 'notARequest'] };
			}
			if (has('file')) return { primary: 'attach', also: ['reply', 'decline', 'markDone'] };
			if (has('meeting')) return { primary: 'proposeTimes', also: ['reply', 'decline'] };
			return { primary: 'reply', also: ['decline', 'markDone', 'remind'] };
	}
}

/** The one primary reaction an item shows (plan §5). */
export function primaryReaction(
	intent: ItemIntent,
	facets: readonly ItemFacet[],
	responsibility: ItemResponsibility,
	options: ReactionOptions = {}
): ItemReaction {
	return chooseReactions(intent, facets, responsibility, options).primary;
}

/** The reactions that sit in the item's ⋯ menu besides the primary one (plan §5 "Also in ⋯"). */
export function secondaryReactions(
	intent: ItemIntent,
	facets: readonly ItemFacet[],
	responsibility: ItemResponsibility,
	options: ReactionOptions = {}
): readonly ItemReaction[] {
	return chooseReactions(intent, facets, responsibility, options).also;
}

// ── Ordering and risk ──────────────────────────────────────────────────────

/** Higher = riskier. An item's risk is its riskiest facet. */
const FACET_RISK: Record<ItemFacet, number> = {
	payment: 6,
	signature: 5,
	access: 4,
	documentReview: 3,
	file: 2,
	meeting: 1,
	information: 0,
};

/** An item's risk: its riskiest facet, -1 with no facets. */
export function itemFacetRisk(facets: readonly ItemFacet[]): number {
	let risk = -1;
	for (const facet of facets) risk = Math.max(risk, FACET_RISK[facet]);
	return risk;
}

export interface ForYouSortable {
	/** `due.at` (ms epoch) when the due phrase resolved to a date. */
	due?: { at?: number | null } | null;
	facets: readonly ItemFacet[];
	/** When the item was first asked (message date of its first evidence), ms epoch. */
	askedAt: number;
	/** Final tie-break, so the order is total and stable. */
	id?: string;
}

/** Width of a zero-padded epoch-ms number in a sort key (covers year 2286). */
const MS_WIDTH = 13;

function padMs(ms: number): string {
	return String(Math.max(0, Math.min(Math.floor(ms), 10 ** MS_WIDTH - 1))).padStart(MS_WIDTH, '0');
}

/**
 * The "For you" order as one string, so a database index on it returns the
 * same order {@link compareForYou} gives: earliest due date first (undated
 * last), then riskier facets, then older items, then `id`. Stored on an item
 * (`threadItems.sortKey`), the first row of a list is the list's top item.
 */
export function forYouSortKey(item: ForYouSortable): string {
	const at = item.due?.at;
	const due = at === undefined || at === null ? `1${'0'.repeat(MS_WIDTH)}` : `0${padMs(at)}`;
	// Risk -1..6, riskier first: rank 7..0.
	const riskRank = String(6 - itemFacetRisk(item.facets));
	return `${due}|${riskRank}|${padMs(item.askedAt)}|${item.id ?? ''}`;
}

/**
 * The "For you" order: earliest due date first (undated last), then riskier
 * facets, then older items first. Ties fall back to `id`. Defined by
 * {@link forYouSortKey}, so an index on the key and this comparator agree.
 */
export function compareForYou(a: ForYouSortable, b: ForYouSortable): number {
	const keyA = forYouSortKey(a);
	const keyB = forYouSortKey(b);
	return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

const CONSEQUENTIAL_FACETS: ReadonlySet<ItemFacet> = new Set<ItemFacet>([
	'payment',
	'signature',
	'access',
]);

export interface ConsequentialInput {
	intent: ItemIntent;
	facets: readonly ItemFacet[];
	amount?: unknown;
	due?: unknown;
	/**
	 * The model's consequence tags (`ITEM_CONSEQUENCE_KINDS`). `undefined` or
	 * `null` means the model did not say: treated as consequential.
	 */
	consequences?: readonly ItemConsequenceKind[] | null;
}

/**
 * Whether an item proposal goes through the verifier (SPEC §4 verify): any
 * consequence tag (payment, signature, access, disclosure, promise,
 * concession, cancellation), a promise, a payment/signature/access facet, a
 * stated amount, or a deadline. Missing tags are ambiguity, and ambiguity is
 * consequential. Ownership, closing transitions and fact supersession are
 * verified as well; that is decided per claim kind by the verifier, not by
 * this item test.
 */
export function isConsequential(item: ConsequentialInput): boolean {
	if (item.consequences == null) return true;
	if (item.consequences.length > 0) return true;
	if (item.intent === 'promise') return true;
	if (item.amount != null || item.due != null) return true;
	return item.facets.some((facet) => CONSEQUENTIAL_FACETS.has(facet));
}

// ── Lifecycle edges ────────────────────────────────────────────────────────

/** The reducer's legal status edges. `superseded` is terminal; `untracked → open` is user-only. */
export const LEGAL_STATUS_EDGES: Readonly<Record<ItemStatus, readonly ItemStatus[]>> = {
	open: ['done', 'declined', 'superseded', 'untracked'],
	done: ['open'],
	declined: ['open'],
	superseded: [],
	untracked: ['open'],
};

/** Whether `actor` may move an item from `from` to `to`. A same-state "edge" is not an edge. */
export function isLegalStatusEdge(from: ItemStatus, to: ItemStatus, actor: ActivityActor): boolean {
	if (!LEGAL_STATUS_EDGES[from].includes(to)) return false;
	if (from === 'untracked' && actor !== 'user') return false;
	return true;
}

/**
 * Disposition edges (plan §5): `unanswered → answered | accepted | deferred |
 * declined`, and any → `failed` (the only send that carried it failed). Two
 * additions: a `failed` disposition is recomputed from the sends that remain
 * (back to `unanswered`, or to what a successful resend said), and a
 * `deferred` item can still be answered, accepted or declined later.
 */
export function isLegalDispositionEdge(from: ItemDisposition, to: ItemDisposition): boolean {
	if (from === to) return false;
	if (to === 'failed') return true;
	if (from === 'failed') return true;
	if (from === 'deferred') return to === 'answered' || to === 'accepted' || to === 'declined';
	return from === 'unanswered';
}

// ── Response plan stances (SPEC §6) ────────────────────────────────────────

const ACCEPTING_FACETS: ReadonlySet<ItemFacet> = new Set<ItemFacet>([
	'payment',
	'signature',
	'access',
]);
/** A file to send or a time to pick is answered, even when it also needs a signature. */
const DELIVERING_FACETS: ReadonlySet<ItemFacet> = new Set<ItemFacet>(['file', 'meeting']);
const ANSWERING_FACETS: ReadonlySet<ItemFacet> = new Set<ItemFacet>([
	'information',
	'documentReview',
]);

/**
 * The stances Answer mode offers for an item (plan §6): a decision is
 * accepted, declined, deferred or held for the owner's input ("Ask"); so is a
 * request with money, a signature or access in it, unless what it asks for is
 * a file or a meeting time, which is answered, declined or deferred, like a
 * question or a request for information; any other request is accepted,
 * declined or deferred; a promise of ours is answered (an update) or
 * deferred. `skip` is never offered: an unselected item is skipped.
 */
export function stanceChoicesFor(
	intent: ItemIntent,
	facets: readonly ItemFacet[]
): readonly ResponseStance[] {
	const has = (set: ReadonlySet<ItemFacet>) => facets.some((f) => set.has(f));
	if (intent === 'promise') return ['answer', 'defer'];
	if (intent === 'question') return ['answer', 'decline', 'defer'];
	if (intent === 'decision') return ['accept', 'decline', 'defer', 'clarify'];
	if (has(DELIVERING_FACETS)) return ['answer', 'decline', 'defer'];
	if (has(ACCEPTING_FACETS)) return ['accept', 'decline', 'defer', 'clarify'];
	if (has(ANSWERING_FACETS)) return ['answer', 'decline', 'defer'];
	return ['accept', 'decline', 'defer'];
}

/**
 * The stance a plan starts with for an item: `clarify` while a clarification
 * slot of the item is still unanswered (the owner has to supply something),
 * otherwise `answer`. A request is never accepted by default: accepting a
 * price, a deadline, a concession or a disclosure takes the owner's choice or a
 * policy (SPEC §6).
 */
export function defaultStance(options: { hasOpenSlot: boolean }): ResponseStance {
	return options.hasOpenSlot ? 'clarify' : 'answer';
}

// ── Draft binding (SPEC §6) ────────────────────────────────────────────────

/** Whitespace-insensitive form of a draft: what a plan's hash and spans read. */
export function normalizeDraftText(text: string): string {
	return text
		.replace(/\r\n?/g, '\n')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

async function sha256Hex32(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 32);
}

/** The hash a coverage result is bound to: SHA-256 of the normalized draft, 32 hex chars. */
export function draftHashOf(text: string): Promise<string> {
	return sha256Hex32(normalizeDraftText(text));
}

/** The hash of an attachment set (order-free): the files a send carries. */
export function attachmentSetHashOf(ids: readonly string[]): Promise<string> {
	return sha256Hex32([...new Set(ids)].sort().join('\n'));
}
