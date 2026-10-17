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

/** The gist as the reader shows it: verbatim spans of one message, never a summary. */
export interface ReaderGist {
	quotes: string[];
	/** The message the spans were cut from, when the read names it (attribution). */
	messageId?: string;
}

function quotesOf(spans: unknown): string[] {
	if (!Array.isArray(spans)) return [];
	return spans
		.map((span) => (span as { quote?: unknown } | null)?.quote)
		.filter((quote): quote is string => typeof quote === 'string' && quote.trim() !== '')
		.map((quote) => quote.trim());
}

/**
 * Typed adapter for `brief.get`'s gist. Lane arrival adds the field (SPEC
 * §2.4, the unsealed `threadBriefs.gist`: `{ spans: { quote }[], … }`); until
 * then the view has none and this returns null. Accepts the spans shape with
 * an optional `messageId`, or a `{ text }` line like `briefTop.gist`.
 */
export function readerGistOf(brief: BriefModeView | null | undefined): ReaderGist | null {
	const raw = (brief as { gist?: unknown } | null | undefined)?.gist as
		| { spans?: unknown; text?: unknown; messageId?: unknown }
		| null
		| undefined;
	if (!raw || typeof raw !== 'object') return null;
	const quotes =
		typeof raw.text === 'string' && raw.text.trim() ? [raw.text.trim()] : quotesOf(raw.spans);
	if (quotes.length === 0) return null;
	return typeof raw.messageId === 'string' ? { quotes, messageId: raw.messageId } : { quotes };
}

/**
 * Typed adapter for a list row's gist (`briefTop.gist`, SPEC §2.9). Lane arrival
 * opens it in `openBriefTop`; until then `BriefTopRow` has no `gist` and this
 * returns null. A fenced thread has no `briefTop` at all, so no gist either.
 */
export function rowGistOf(briefTop: BriefTopRow | undefined): string | null {
	const gist = (briefTop as { gist?: { text?: unknown } } | undefined)?.gist;
	const text = typeof gist?.text === 'string' ? gist.text.trim() : '';
	return text || null;
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
		// Nothing recorded yet. Quietly say it is being read when this open is
		// what reads it; otherwise the strip just fades in once it is ready.
		return { kind: 'meta', note: (brief.deferredSources ?? 0) > 0 ? 'reading' : null };
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
