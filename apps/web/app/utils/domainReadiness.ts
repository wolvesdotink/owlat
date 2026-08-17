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

/**
 * A translatable value produced by a module-scope helper: the message KEY the
 * rendering component resolves, plus the parameters it interpolates.
 */
export type LocalizedText = string | { key: string; params?: Record<string, unknown> };

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
 *
 * A module-scope helper never calls `useI18n`, so it hands back the message KEY
 * and the record names it interpolates (the registry convention); the row that
 * renders the line resolves them. The record names themselves are the protocol
 * acronyms (SPF, DKIM, DMARC, MAIL FROM) and read the same in every language,
 * which is why they travel as parameters rather than as keys of their own — and
 * the list grammar stays in the catalog, where a translator can reorder it.
 */
export function domainReadinessMessage(summary: DomainReadinessSummary): LocalizedText {
	if (summary.total === 0) return 'shared.domainReadiness.noRecords';
	if (summary.allVerified) return 'shared.domainReadiness.allVerified';

	const { missingLabels } = summary;
	// "Almost ready" when only one category is left; otherwise a neutral prompt.
	if (missingLabels.length === 1) {
		return {
			key: 'shared.domainReadiness.almostReady',
			params: { record: missingLabels[0] },
		};
	}
	return {
		key: 'shared.domainReadiness.addRecords',
		params: {
			leading: missingLabels.slice(0, -1).join(', '),
			last: missingLabels[missingLabels.length - 1],
		},
	};
}
