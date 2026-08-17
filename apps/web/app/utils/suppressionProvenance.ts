/**
 * "Who put this here?" for a suppressed address.
 *
 * A `manual` suppression used to have exactly one meaning: a person typed the
 * address in. Since the Mandrill reject sync (plan D9) it can also mean the
 * provider's own blacklist rejected the address and Owlat mirrored that
 * decision — no operator anywhere in the story. Those two are identical on the
 * row, so the screen has to say which one it was, or every provider-driven
 * suppression looks like a colleague's unexplained decision.
 *
 * The fact lives in the `blocklist.provider_suppressed` audit entry rather than
 * in a column (provenance is an event: re-blocking an already-blocked address
 * writes nothing, so a column would record only whichever cause arrived first).
 * This module turns those entries into a per-row lookup and one sentence.
 */

/** One `blocklist.provider_suppressed` entry, as the query returns it. */
export interface SuppressionProvenanceEntry {
	readonly blockedEmailId: string;
	readonly provider: string;
	readonly source: string;
	readonly evidence: string | null;
	readonly recordedAt: number;
}

/**
 * Index provenance by the blocklist row it explains, newest wins.
 *
 * Newest rather than oldest because the entries arrive newest-first and a
 * second entry for the same row can only come from a re-block after a removal —
 * the current reason, not the historic one.
 */
export function indexSuppressionProvenance(
	entries: readonly SuppressionProvenanceEntry[] | undefined
): Map<string, SuppressionProvenanceEntry> {
	const byId = new Map<string, SuppressionProvenanceEntry>();
	for (const entry of entries ?? []) {
		const existing = byId.get(entry.blockedEmailId);
		if (existing === undefined || entry.recordedAt > existing.recordedAt) {
			byId.set(entry.blockedEmailId, entry);
		}
	}
	return byId;
}

/**
 * THE PROVIDER IS PART OF THE KEY, not a parameter.
 *
 * Two of these names are copy rather than trademarks — "your SMTP relay", "your
 * own mail server" — and a translated noun cannot be handed to `t()` as an
 * interpolation, so the sentence is picked per provider instead. A provider with
 * no name of its own falls through to the `other` messages, which DO take the
 * raw kind as a parameter: that value is configuration, not copy.
 */
const NAMED_PROVIDERS = ['mandrill', 'ses', 'resend', 'smtp', 'mta'] as const;

/** A translatable sentence: a catalog key plus the values its message fills in. */
export interface SuppressionProvenanceText {
	readonly key: string;
	readonly params?: Record<string, string>;
}

/**
 * The provenance sentence, or null when nothing is known — in which case the row
 * really was a human decision (or predates provenance tracking) and the screen
 * says nothing rather than guessing.
 *
 * `evidence` is the provider's own reason code and is shown VERBATIM: it is the
 * only part that answers "why", and paraphrasing a third party's taxonomy into
 * ours would invent a claim we cannot stand behind. It travels as a parameter of
 * the message, so the separator stays the translation's business.
 */
export function suppressionProvenanceLine(
	entry: SuppressionProvenanceEntry | undefined
): SuppressionProvenanceText | null {
	if (entry === undefined) return null;
	const named = (NAMED_PROVIDERS as readonly string[]).includes(entry.provider);
	const provider = named ? entry.provider : 'other';
	const how = entry.source === 'import' ? 'carriedOver' : 'reported';
	const suffix = entry.evidence === null ? '' : 'WithEvidence';
	return {
		key: `shared.suppressionProvenance.${provider}.${how}${suffix}`,
		params: {
			...(named ? {} : { provider: entry.provider }),
			...(entry.evidence === null ? {} : { evidence: entry.evidence }),
		},
	};
}
