/**
 * Domain readiness summary (Settings → Domains DNS panel).
 *
 * Composes the per-record `verificationResults` a sending domain already
 * carries into a single, glanceable "is this domain ready to send?" line:
 * a compact SPF / DKIM / DMARC / MAIL FROM check/cross strip plus a
 * plain-language tail ("Almost ready — just add the DMARC record").
 *
 * Pure data composition — no network, no backend call. It only counts the
 * record categories the domain *actually has* (from `dnsRecords`), so a domain
 * without, say, an SPF record is never marked "missing SPF". A category backed
 * by multiple records (DKIM, MAIL FROM) is verified only when every one of its
 * records verifies.
 */

/** A single record's verification outcome, as stored on the domain. */
type VerificationEntry = { verified?: boolean } | null | undefined;

/** The `verificationResults` object a sending domain carries. */
export type DomainVerificationResults =
	| {
			spf?: VerificationEntry;
			dkim?: VerificationEntry[];
			dmarc?: VerificationEntry;
			mailFrom?: VerificationEntry[];
	  }
	| null
	| undefined;

/**
 * The `dnsRecords` object — only its *presence* per category matters here, so
 * every field is intentionally loose.
 */
export type ReadinessDnsRecords =
	| {
			spf?: unknown;
			dkim?: unknown[] | null;
			dmarc?: unknown;
			mailFrom?: unknown[] | null;
	  }
	| null
	| undefined;

/** One chip in the readiness strip. */
export type DomainReadinessChip = { label: string; verified: boolean };

export type DomainReadinessSummary = {
	/** Number of record categories the domain actually has. */
	total: number;
	/** Number of those categories that are fully verified. */
	verified: number;
	/** Labels of present-but-unverified categories, in display order. */
	missingLabels: string[];
	/** True when the domain has at least one record and all of them verify. */
	allVerified: boolean;
	/** Per-category chips, in display order, for the ones the domain has. */
	chips: DomainReadinessChip[];
};

const hasItems = (value: unknown[] | null | undefined): value is unknown[] =>
	Array.isArray(value) && value.length > 0;

/** Every record in a multi-record category must verify for the category to. */
const allEntriesVerified = (
	records: unknown[],
	results: VerificationEntry[] | undefined
): boolean => records.every((_, i) => results?.[i]?.verified === true);

/**
 * Summarise a sending domain's DNS readiness from data already on the domain.
 * Fail-soft: missing / partial inputs simply yield fewer counted categories.
 */
export function summarizeDomainReadiness(
	verificationResults: DomainVerificationResults,
	dnsRecords: ReadinessDnsRecords
): DomainReadinessSummary {
	const chips: DomainReadinessChip[] = [];

	if (dnsRecords?.spf) {
		chips.push({ label: 'SPF', verified: verificationResults?.spf?.verified === true });
	}
	if (hasItems(dnsRecords?.dkim)) {
		chips.push({
			label: 'DKIM',
			verified: allEntriesVerified(dnsRecords.dkim, verificationResults?.dkim),
		});
	}
	if (dnsRecords?.dmarc) {
		chips.push({ label: 'DMARC', verified: verificationResults?.dmarc?.verified === true });
	}
	if (hasItems(dnsRecords?.mailFrom)) {
		chips.push({
			label: 'MAIL FROM',
			verified: allEntriesVerified(dnsRecords.mailFrom, verificationResults?.mailFrom),
		});
	}

	const total = chips.length;
	const verified = chips.filter((c) => c.verified).length;
	const missingLabels = chips.filter((c) => !c.verified).map((c) => c.label);

	return {
		total,
		verified,
		missingLabels,
		allVerified: total > 0 && verified === total,
		chips,
	};
}

/**
 * Plain-language tail for the readiness line — kept beside the helper so the
 * copy and the counts never drift.
 */
export function domainReadinessMessage(summary: DomainReadinessSummary): string {
	if (summary.total === 0) return 'No DNS records to verify yet';
	if (summary.allVerified) return 'All records verified';

	const { missingLabels } = summary;
	const list =
		missingLabels.length === 1
			? `the ${missingLabels[0]} record`
			: `the ${missingLabels.slice(0, -1).join(', ')} and ${missingLabels[missingLabels.length - 1]} records`;

	// "Almost ready" when only one category is left; otherwise a neutral prompt.
	return missingLabels.length === 1
		? `Almost ready — just add ${list}`
		: `Add ${list} to finish setup`;
}
