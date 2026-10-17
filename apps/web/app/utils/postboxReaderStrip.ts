/**
 * The calm reader's one element under the header (SPEC §3, plan §6): the brief
 * strip, or, when there is nothing to say yet, a slim "Why here? · Details"
 * line in its place. Pure, so every state is unit-testable without the reader.
 *
 *   - `brief`: the lead (the brief's first "Latest update" line, else the gist
 *     quoted verbatim with its sender), the first open "For you" item and the
 *     first open "Waiting on others" item.
 *   - `gist`: gist-depth mail. The gist line is the whole strip; a shipping
 *     notice gets one sentence, not a card.
 *   - `meta`: no strip. A pending brief, a thread whose sources were all
 *     skipped, count/none depth (nothing was read, so there is no gist), a
 *     shared mailbox, mail whose original is the primary view. Never a skeleton: the strip fades in when
 *     the brief is ready. `note: 'reading'` is the one quiet line that replaces
 *     the old skeleton while messages wait for this open to be read (D10, or
 *     read on arrival turned off).
 */
import type { BriefItemView, BriefModeView } from '../../../api/convex/mail/interpret/briefShape';
import type { BriefTopRow } from '../../../api/convex/mail/interpret/briefTop';
import type { BriefAction } from '~/utils/threadBriefItems';

/** The gist as the reader shows it: verbatim spans of one message, never a summary. */
export interface ReaderGist {
	quotes: string[];
	/** The message the spans were cut from, when the read names it (attribution). */
	messageId?: string;
}

/**
 * `brief.get`'s gist (SPEC §2.4: the unsealed `threadBriefs.gist`, verbatim
 * spans of one message and that message's id), or null when it has none.
 */
export function readerGistOf(brief: BriefModeView | null | undefined): ReaderGist | null {
	const gist = brief?.gist;
	if (!gist) return null;
	const quotes = gist.spans.map((span) => span.quote.trim()).filter((quote) => quote !== '');
	if (quotes.length === 0) return null;
	return gist.messageId ? { quotes, messageId: gist.messageId } : { quotes };
}

/**
 * A list row's gist line (`briefTop.gist`, opened by `openBriefTop`). A fenced
 * thread has no `briefTop` at all, so no gist either.
 */
export function rowGistOf(briefTop: BriefTopRow | undefined): string | null {
	return briefTop?.gist?.text.trim() || null;
}

export type ReaderStrip =
	| {
			kind: 'brief';
			/** The lead sentence, or null when the strip only carries items (a fenced brief). */
			lead: { kind: 'latest'; text: string } | { kind: 'gist'; gist: ReaderGist } | null;
			owe: BriefItemView | null;
			waiting: BriefItemView | null;
	  }
	| { kind: 'gist'; gist: ReaderGist }
	| { kind: 'meta'; note: 'reading' | null };

export interface ReaderStripInput {
	/** A team mailbox: no brief strip, no arrival (it has no records). */
	isShared: boolean;
	/** undefined while loading, null when the server has no brief. */
	brief: BriefModeView | null | undefined;
	gist: ReaderGist | null;
	/**
	 * The viewer's read-on-arrival preference (`getArrivalPreference`): on, a
	 * pending brief is being read now; off, only when this open reads it.
	 */
	isReadOnArrival?: boolean;
}

const META: ReaderStrip = { kind: 'meta', note: null };

function firstOpen(items: readonly BriefItemView[] | undefined): BriefItemView | null {
	return items?.find((item) => item.status === 'open') ?? null;
}

export function resolveReaderStrip(input: ReaderStripInput): ReaderStrip {
	const { brief } = input;
	if (input.isShared || !brief) return META;
	const reason = brief.gap?.reason;
	// The original is the primary view: short mail, security mail.
	if (reason === 'short' || reason === 'security') return META;
	if (brief.completeness === 'none' || brief.completeness === 'pending') {
		// Nothing recorded yet. Quietly say it is being read: when this open is
		// what reads it (D10), or when mail is read as it arrives. Otherwise the
		// strip just fades in once it is ready.
		const isBeingRead = (brief.deferredSources ?? 0) > 0 || input.isReadOnArrival === true;
		return { kind: 'meta', note: isBeingRead ? 'reading' : null };
	}
	const latest = brief.latest?.[0]?.text.trim();
	const owe = firstOpen(brief.forYou);
	const waiting = firstOpen(brief.waitingOnOthers);
	if (!latest && !owe && !waiting) {
		// Gist-depth mail (or a full read that found nothing to list): the gist
		// line alone. Count/none depth and all-skipped threads have no gist.
		return input.gist ? { kind: 'gist', gist: input.gist } : META;
	}
	const lead = latest
		? ({ kind: 'latest', text: latest } as const)
		: input.gist
			? ({ kind: 'gist', gist: input.gist } as const)
			: null;
	return { kind: 'brief', lead, owe, waiting };
}

/** How long the gist line may run (SPEC §2.4: a list row's gist is ≤160 characters). */
export const GIST_LINE_MAX = 160;

/**
 * The gist as one line: its spans joined, cut at a word boundary with an
 * ellipsis once it passes {@link GIST_LINE_MAX}. A single over-long word is cut
 * mid-word rather than dropped.
 */
export function gistLine(gist: ReaderGist, max: number = GIST_LINE_MAX): string {
	const line = gist.quotes.join(' … ');
	if (line.length <= max) return line;
	const room = line.slice(0, max - 1);
	const cut = room.lastIndexOf(' ');
	return `${(cut > 0 ? room.slice(0, cut) : room).replace(/[\s.,;:…-]+$/, '')}…`;
}

/**
 * Whether "Full brief" has anything to open, independent of what the strip
 * shows: any item in any state (open, closed, unclear, hidden), a fact or an
 * overview, activity, files, or other people to look up elsewhere.
 */
export function briefHasContent(brief: BriefModeView | null | undefined): boolean {
	if (!brief || brief.completeness === 'none') return false;
	const { counts } = brief;
	return (
		(brief.latest?.length ?? 0) > 0 ||
		brief.forYou.length + brief.waitingOnOthers.length + brief.unclear.length > 0 ||
		counts.forYou + counts.waitingOnOthers + counts.unclear + counts.closed + counts.hidden > 0 ||
		(brief.standing?.facts.length ?? 0) > 0 ||
		!!brief.standing?.overview ||
		brief.activity.length > 0 ||
		brief.files.length > 0 ||
		brief.participants.some((p) => !p.isUs)
	);
}

/**
 * The actions the strip offers on the item you owe, with BriefItem's
 * semantics: an unconfirmed proposal ("Check this") is not an obligation
 * until confirmed, so it offers Track and "Not a request"; a tracked item
 * offers Reply and Mark done.
 */
export function stripItemActions(item: Pick<BriefItemView, 'verify'>): BriefAction[] {
	return item.verify === 'proposal' ? ['confirmProposal', 'notARequest'] : ['reply', 'markDone'];
}
