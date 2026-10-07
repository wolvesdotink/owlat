/**
 * Pure presentation rules of the thread brief (SPEC §7, plan §5 "Item states"
 * and §4.1 rows): the ring an item shows, which evidence a cite points at, and
 * the one line a list row shows instead of its snippet. Free of Vue and Convex
 * so each rule is unit-testable.
 */
import type { ItemReaction, ItemStateKey } from '@owlat/shared/threadBrief';
import { secondaryReactions } from '@owlat/shared/threadBriefRules';
import type {
	BriefItemView,
	BriefModeView,
	EvidenceView,
} from '../../../api/convex/mail/interpret/briefShape';
import type { CiteParam } from '~/utils/threadBriefView';

/** What a person can do to an item: a reaction, or undoing their own statement. */
export type BriefAction = ItemReaction | 'undo' | 'confirmProposal';

/** Whether the viewer's own statement about the item can be taken back. */
export function canUndo(stateKey: ItemStateKey): boolean {
	return stateKey === 'markedDoneByYou' || stateKey === 'notTracked';
}

/** The ring left of an item (plan §5 "Item states"). */
export type BriefRing = 'open' | 'half' | 'done' | 'declined' | 'replaced' | 'proposal' | 'waiting';

export function briefRing(
	item: Pick<BriefItemView, 'responsibility' | 'verify'>,
	stateKey: ItemStateKey
): BriefRing {
	if (item.verify === 'proposal') return 'proposal';
	switch (stateKey) {
		case 'answeredStillToDo':
			return 'half';
		case 'done':
		case 'markedDoneByYou':
		case 'reportedDone':
			return 'done';
		case 'declined':
			return 'declined';
		case 'replaced':
		case 'notTracked':
			return 'replaced';
		default:
			return item.responsibility === 'them' ? 'waiting' : 'open';
	}
}

/** A state worth a chip next to the text: everything except plain open. */
export function showsStateChip(stateKey: ItemStateKey): boolean {
	return stateKey !== 'open';
}

/**
 * The ⋯ menu of an item: the reactions besides the primary one, minus what a
 * personal mailbox cannot do (assign is a team verb). Reply comes first when it
 * is not the primary, as in the plan's menu.
 */
export function menuReactions(
	item: Pick<BriefItemView, 'intent' | 'facets' | 'responsibility' | 'primaryReaction'>,
	opts: { isTeam?: boolean } = {}
): ItemReaction[] {
	const rest = secondaryReactions(item.intent, item.facets, item.responsibility).filter(
		(r) => r !== item.primaryReaction && (opts.isTeam || r !== 'assign')
	);
	return [...new Set(rest)];
}

/** Reactions that open Answer mode rather than change the item. */
const REPLYING: ReadonlySet<ItemReaction> = new Set<ItemReaction>([
	'reply',
	'replyWithStance',
	'replyWithUpdate',
	'attach',
	'proposeTimes',
	'nudge',
	'decline',
]);

export function isReplyReaction(reaction: ItemReaction): boolean {
	return REPLYING.has(reaction);
}

/** Initials for an evidence marker or an avatar: "Jonas Weber" → "JW". */
export function initialsOf(name: string | undefined, email: string | undefined): string {
	const source = name?.trim() || email?.split('@')[0] || '';
	const words = source.split(/[\s._-]+/).filter(Boolean);
	if (words.length === 0) return '?';
	const letters = words.length === 1 ? words[0]!.slice(0, 2) : words[0]![0]! + words.at(-1)![0]!;
	return letters.toUpperCase();
}

/** What a cite param points at, resolved against the brief. */
export interface ResolvedCite {
	/** The mailMessages id the quote is in (only mail sources can be shown in the reader). */
	messageId: string;
	quote: string | null;
	/** Which occurrence of the quote's words in the message it is (0 = the first). */
	occurrence?: number;
	/** How many matches of the words the interpreted (visible) text holds. */
	occurrenceCount?: number;
	/** The cited line's own text, for "Showing the source of …". */
	label: string;
}

function evidenceAt(list: readonly EvidenceView[], index: number): EvidenceView | undefined {
	return list[index] ?? list[0];
}

export function resolveCite(brief: BriefModeView, cite: CiteParam): ResolvedCite | null {
	let label: string | undefined;
	let evidence: EvidenceView | undefined;
	const latestIndex = /^latest-(\d+)$/.exec(cite.ref);
	if (latestIndex) {
		const line = brief.latest?.[Number(latestIndex[1])];
		label = line?.text;
		evidence = line ? evidenceAt(line.evidence, cite.quoteIndex) : undefined;
	} else {
		const items = [...brief.forYou, ...brief.waitingOnOthers, ...brief.unclear];
		const item = items.find((i) => i.id === cite.ref);
		const fact = brief.standing?.facts.find((f) => f.id === cite.ref);
		label = item?.text ?? fact?.text;
		evidence = evidenceAt(item?.evidence ?? fact?.evidence ?? [], cite.quoteIndex);
	}
	if (!evidence || label === undefined) return null;
	const { source } = evidence;
	if (source.kind !== 'mail' && source.kind !== 'outboundMail') return null;
	return {
		messageId: source.id,
		quote: evidence.quote ?? null,
		...(evidence.occurrence !== undefined ? { occurrence: evidence.occurrence } : {}),
		...(evidence.occurrenceCount !== undefined
			? { occurrenceCount: evidence.occurrenceCount }
			: {}),
		label,
	};
}

/** The per-message "Latest update" sentence (collapsed rows of Conversation). */
export function messageLatestMap(brief: BriefModeView | null | undefined): Map<string, string> {
	return new Map((brief?.messageLatest ?? []).map((m) => [m.messageId, m.text]));
}
