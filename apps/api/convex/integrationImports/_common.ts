/**
 * Integration import provider adapter (module) — shared types.
 *
 * One TypeScript interface, N concrete adapters (Mailchimp, Stripe, Mandrill
 * today).
 * The **Integration import walker** dispatches per-provider work through
 * `providerFor(kind)` in `./providers`; provider variation lives entirely
 * behind this seam.
 *
 * Per ADR-0027.
 */

import { v } from 'convex/values';
import type { ImportRow, ImportSource } from '../contacts/import';

// ─── Discriminator ──────────────────────────────────────────────────────────

export const INTEGRATION_PROVIDER_KINDS = ['mailchimp', 'stripe', 'mandrill'] as const;
export type IntegrationProviderKind = (typeof INTEGRATION_PROVIDER_KINDS)[number];

// ─── Per-provider config shapes (discriminated union) ───────────────────────

/**
 * `mandrill` carries NO credential field, and that is the decision, not an
 * omission. Mandrill is a SEND provider here, and plan D2 froze send-provider
 * credentials as env-only (`MANDRILL_API_KEY`): there is deliberately no
 * transports table, so a key pasted into an import form would be a second
 * credential model for the same account. The rejects importer therefore reads
 * the same env var the send adapter does and the run config carries only the
 * non-secret question — which is, for a whole-account blacklist, nothing at all.
 *
 * Mailchimp keeps its pasted key: the Marketing API is a DIFFERENT system with a
 * different key, connected per-import and never used to send.
 */
export type IntegrationProviderConfig =
	| {
			provider: 'mailchimp';
			apiKey: string;
			listId: string;
			/**
			 * Opt-in: also carry over the audience's `unsubscribed` and `cleaned`
			 * members as suppressions (plan D9). Absent/false = the pre-P4.1
			 * behavior exactly — those members are skipped and nothing is written
			 * to the blocklist.
			 */
			importSuppressions?: boolean;
	  }
	| { provider: 'stripe'; apiKey: string }
	| { provider: 'mandrill' };

// ─── DOI attest source ──────────────────────────────────────────────────────

/**
 * The per-provider default DOI attestation, threaded into the **Contact
 * import (module)**'s `importBatch` as `doiAttest.attestSource` when the
 * adapter defines one. Constrained to the `ImportSource` literal so that
 * the `contacts.import` `attestSource` and the integration's `provider`
 * stay in lockstep.
 */
export type AttestSource = ImportSource;

// ─── Retryable error class ──────────────────────────────────────────────────

/**
 * Thrown by an adapter's `fetchPage` to signal "retry me up to N more
 * times." The walker catches it, backs off, and retries — any other thrown
 * `Error` fails the import immediately.
 */
export class RetryableProviderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RetryableProviderError';
	}
}

// ─── Suppression carry-over (plan D9) ───────────────────────────────────────

/**
 * One address a provider has already stopped mailing, on its way into Owlat's
 * own suppression state.
 *
 * Flat rather than a nested discriminated union because it crosses an
 * action→mutation boundary and has to have a Convex validator
 * (`suppressionEntryValidator` in `./suppressions`); the walker never inspects
 * it beyond handing it over.
 *
 * `reason` is the same vocabulary `blockedEmails.reason` uses, plus the one
 * disposition that is NOT a blocklist row: `unsubscribe` routes to the consent
 * path (membership delete, opt-out stamp, webhook fanout), because recording an
 * opt-out as a block would keep the address unmailed while skipping every piece
 * of accounting that makes it a legitimate departure.
 */
export type SuppressionRow = {
	email: string;
	reason: 'bounced' | 'complained' | 'manual' | 'unsubscribe';
	/** Only meaningful for `bounced`; drives the MTA mirror's permanence. */
	bounceType?: 'hard' | 'soft';
	/** The provider's own reason code, recorded as the audit entry's `evidence`. */
	evidence: string;
};

/**
 * Per-disposition tally of a suppression carry-over (one page at a time, then
 * accumulated on the `integrationImports` row and reported once at the end).
 *
 * The "new" counters and the "already" counters are separate on purpose: the
 * whole promise of a re-runnable carry-over is that the second run changes
 * nothing, and a single "suppressed" number cannot tell an operator whether
 * that held.
 *
 * Lives in this seam file rather than beside the mutation that produces it
 * because `schema/integrations.ts` persists it — and a schema module must not
 * import a module that reaches `_generated/server`.
 */
export type SuppressionImportCounts = {
	/** New blocklist rows, by the reason they were written with. */
	bouncedHard: number;
	bouncedSoft: number;
	complained: number;
	manual: number;
	/** Address was already on the blocklist — the writer wrote nothing. */
	alreadyBlocked: number;
	/** Contact was unsubscribed from at least one topic by this import. */
	unsubscribed: number;
	/** Contact was already fully unsubscribed — no membership to remove. */
	alreadyUnsubscribed: number;
	/** An unsubscribe for an address that is not a contact here. Nothing to do. */
	noContact: number;
	/** Provider entry that maps to no recipient truth, or is not a valid address. */
	skipped: number;
};

/** The Convex shape of `SuppressionImportCounts` — schema + args share it. */
export const suppressionCountsValidator = v.object({
	bouncedHard: v.number(),
	bouncedSoft: v.number(),
	complained: v.number(),
	manual: v.number(),
	alreadyBlocked: v.number(),
	unsubscribed: v.number(),
	alreadyUnsubscribed: v.number(),
	noContact: v.number(),
	skipped: v.number(),
});

export const ZERO_SUPPRESSION_COUNTS: Readonly<SuppressionImportCounts> = {
	bouncedHard: 0,
	bouncedSoft: 0,
	complained: 0,
	manual: 0,
	alreadyBlocked: 0,
	unsubscribed: 0,
	alreadyUnsubscribed: 0,
	noContact: 0,
	skipped: 0,
};

export function addSuppressionCounts(
	a: SuppressionImportCounts,
	b: SuppressionImportCounts
): SuppressionImportCounts {
	return {
		bouncedHard: a.bouncedHard + b.bouncedHard,
		bouncedSoft: a.bouncedSoft + b.bouncedSoft,
		complained: a.complained + b.complained,
		manual: a.manual + b.manual,
		alreadyBlocked: a.alreadyBlocked + b.alreadyBlocked,
		unsubscribed: a.unsubscribed + b.unsubscribed,
		alreadyUnsubscribed: a.alreadyUnsubscribed + b.alreadyUnsubscribed,
		noContact: a.noContact + b.noContact,
		skipped: a.skipped + b.skipped,
	};
}

/** Did this run actually change anything? Drives the summary's write gate. */
export function suppressionChangeCount(counts: SuppressionImportCounts): number {
	return (
		counts.bouncedHard +
		counts.bouncedSoft +
		counts.complained +
		counts.manual +
		counts.unsubscribed
	);
}

// ─── Adapter contract ───────────────────────────────────────────────────────

export type FetchPageResult = {
	/** Already-normalized rows; ready for `importBatch`. */
	rows: ImportRow[];
	/** `null` = terminal page; `''` is reserved for "first page" cursor. */
	nextCursor: string | null;
	/** Only when the provider gives one (Mailchimp does, Stripe doesn't). */
	totalEstimate?: number;
	/**
	 * Addresses this page carries over into Owlat's suppression state. Absent
	 * (or empty) for a contacts-only import; the walker's suppression hop is
	 * skipped entirely, so an adapter that never sets this is unaffected.
	 */
	suppressions?: SuppressionRow[];
	/**
	 * Entries on this page the adapter saw and deliberately did NOT map to a
	 * suppression (a provider reason that says something about our account
	 * rather than the recipient, a member status that is neither a contact nor
	 * a suppression). Reported so the run summary accounts for every entry.
	 */
	suppressionsSkipped?: number;
};

export interface IntegrationImportProviderModule<K extends IntegrationProviderKind> {
	readonly kind: K;

	/**
	 * The `ImportSource` this adapter's contact rows are attributed to.
	 *
	 * Declared rather than derived from `kind` because it is what makes a
	 * SUPPRESSION-ONLY provider expressible: `mandrill` imports a rejection
	 * blacklist and produces no contacts, so it omits this and the walker never
	 * calls `importBatch` for it. The alternative — widening
	 * `IMPORT_SOURCE_LITERALS` with a source no contact can ever carry — would
	 * put a lie in the contact schema to satisfy a type check.
	 */
	readonly contactSource?: ImportSource;

	/**
	 * Per-provider default DOI attestation. Threaded into Contact import
	 * (module)'s `importBatch` as `doiAttest: { attestSource:
	 * defaultDoiAttest }`. Mailchimp / Stripe both attest as themselves.
	 */
	readonly defaultDoiAttest?: AttestSource;

	/**
	 * Pure check of the per-provider config shape (no I/O). The walker
	 * calls this at `startIntegrationImport` time before scheduling the
	 * first page.
	 */
	validateConfig(
		config: Extract<IntegrationProviderConfig, { provider: K }>
	): { ok: true } | { ok: false; reason: string };

	/**
	 * Provider API call. Cursor is opaque; the adapter interprets it
	 * internally (`''` = first-page sentinel).
	 *
	 * Throws `RetryableProviderError` on 429 / network blip — walker
	 * retries with backoff up to `MAX_RETRIES`.
	 * Throws any other `Error` on fatal — walker marks the import
	 * `failed` immediately with the thrown message.
	 */
	fetchPage(args: {
		config: Extract<IntegrationProviderConfig, { provider: K }>;
		cursor: string;
	}): Promise<FetchPageResult>;
}
