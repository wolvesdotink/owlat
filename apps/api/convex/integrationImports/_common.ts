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
import { withoutApiKey } from '../lib/redactSecret';

// ─── Discriminator ──────────────────────────────────────────────────────────

export const INTEGRATION_PROVIDER_KINDS = ['mailchimp', 'stripe', 'mandrill'] as const;
export type IntegrationProviderKind = (typeof INTEGRATION_PROVIDER_KINDS)[number];

// ─── Per-provider config shapes (discriminated union) ───────────────────────

/**
 * `mandrill` carries NO credential field, and that is the decision, not an
 * omission. Mandrill is a SEND provider here, and send-provider credentials are
 * env-only (`MANDRILL_API_KEY`): there is deliberately no transports table, so a
 * key pasted into an import form would be a second credential model for the same
 * account. The rejects importer therefore reads the same env var the send
 * adapter does and the run config carries only the non-secret question — which
 * is, for a whole-account blacklist, nothing at all.
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
			 * members as suppressions. Absent/false — those members are skipped and
			 * nothing is written to the blocklist.
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

// ─── Provider page fetch ────────────────────────────────────────────────────

/**
 * Gateway statuses that say "the provider's edge could not reach its backend
 * right now". Retried like a 429. A plain 500 is NOT in this set: Mandrill
 * reports account-level failures (`Invalid_Key`, `PaymentRequired`) as HTTP 500,
 * and retrying those only delays the same answer.
 */
const RETRYABLE_GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

export type FetchProviderPageOptions<ErrorBody extends object> = {
	/** Provider name as it appears in error messages, e.g. `'Stripe'`. */
	label: string;
	/** Where the walk was, e.g. `'at offset 200'`. Appended to retry messages. */
	where: string;
	/** The provider's own message from a parsed JSON error body, if it has one. */
	extractMessage: (body: ErrorBody) => string | undefined;
	/**
	 * The adapter's API key. Every message this helper throws is passed through
	 * `withoutApiKey` with it, because a provider that echoes the request inside
	 * an error body would otherwise put the credential into
	 * `integrationImports.errors`, which the import UI renders.
	 */
	secret?: string;
};

/**
 * One provider page request with the walker's error classification applied.
 *
 *  - The fetch itself throwing (DNS, reset, timeout) → `RetryableProviderError`.
 *  - 429 and 502/503/504 → `RetryableProviderError`.
 *  - Any other non-OK status → plain `Error` carrying the provider's own message
 *    (via `extractMessage`) or `<label> API error: <status>`. The walker fails
 *    the import with it.
 *
 * Returns the OK `Response`; the adapter parses the body and maps rows.
 */
export async function fetchProviderPage<ErrorBody extends object>(
	url: string,
	init: RequestInit,
	options: FetchProviderPageOptions<ErrorBody>
): Promise<Response> {
	const { label, where, extractMessage } = options;
	const redact = (text: string) => withoutApiKey(text, options.secret ?? '');

	let response: Response;
	try {
		response = await fetch(url, init);
	} catch (err) {
		throw new RetryableProviderError(
			redact(
				`Network error fetching ${label} page ${where}: ${err instanceof Error ? err.message : 'unknown'}`
			)
		);
	}

	if (response.status === 429) {
		throw new RetryableProviderError(redact(`${label} rate limit (429) ${where}`));
	}
	if (RETRYABLE_GATEWAY_STATUSES.has(response.status)) {
		throw new RetryableProviderError(
			redact(`${label} temporarily unavailable (${response.status}) ${where}`)
		);
	}
	if (!response.ok) {
		const fallback = `${label} API error: ${response.status}`;
		const body = parseJsonObject(await response.text().catch(() => ''));
		const extracted = body ? extractMessage(body as ErrorBody) : undefined;
		throw new Error(redact(typeof extracted === 'string' && extracted ? extracted : fallback));
	}

	return response;
}

function parseJsonObject(text: string): object | null {
	try {
		const parsed: unknown = JSON.parse(text);
		return typeof parsed === 'object' && parsed !== null ? parsed : null;
	} catch {
		// Non-JSON error body — the caller falls back to the status-only message.
		return null;
	}
}

// ─── Suppression carry-over ───────────────────────────────────────

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
	 * Throws `RetryableProviderError` on 429 / 502-504 / network blip —
	 * walker retries with backoff up to `MAX_RETRIES`. `fetchProviderPage`
	 * applies that classification to the HTTP call.
	 * Throws any other `Error` on fatal — walker marks the import
	 * `failed` immediately with the thrown message.
	 */
	fetchPage(args: {
		config: Extract<IntegrationProviderConfig, { provider: K }>;
		cursor: string;
	}): Promise<FetchPageResult>;
}
