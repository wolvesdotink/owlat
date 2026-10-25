/**
 * The Postbox thread's cite links. The reader is one
 * page (read on arrival §3): the Overview / Conversation switch and its
 * opening-view rule are gone; a cite still shows the source of a brief line
 * in the conversation, for this visit only.
 */

/**
 * `?cite=<ref>:<quoteIndex>`: the item or fact id (or `latest-<n>` for a
 * "Latest update" line) and which of its quotes to show.
 */
export interface CiteParam {
	ref: string;
	quoteIndex: number;
}

export function parseCite(raw: unknown): CiteParam | null {
	if (typeof raw !== 'string') return null;
	const cut = raw.lastIndexOf(':');
	if (cut <= 0) return null;
	const quoteIndex = Number(raw.slice(cut + 1));
	if (!Number.isInteger(quoteIndex) || quoteIndex < 0) return null;
	return { ref: raw.slice(0, cut), quoteIndex };
}

export function formatCite(cite: CiteParam): string {
	return `${cite.ref}:${cite.quoteIndex}`;
}

/** The ref a "Latest update" line is cited by. */
export function latestCiteRef(lineIndex: number): string {
	return `latest-${lineIndex}`;
}
