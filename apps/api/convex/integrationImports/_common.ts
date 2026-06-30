/**
 * Integration import provider adapter (module) — shared types.
 *
 * One TypeScript interface, N concrete adapters (Mailchimp, Stripe today).
 * The **Integration import walker** dispatches per-provider work through
 * `providerFor(kind)` in `./providers`; provider variation lives entirely
 * behind this seam.
 *
 * Per ADR-0027.
 */

import type { ImportRow, ImportSource } from '../contacts/import';

// ─── Discriminator ──────────────────────────────────────────────────────────

export const INTEGRATION_PROVIDER_KINDS = ['mailchimp', 'stripe'] as const;
export type IntegrationProviderKind = (typeof INTEGRATION_PROVIDER_KINDS)[number];

// ─── Per-provider config shapes (discriminated union) ───────────────────────

export type IntegrationProviderConfig =
	| { provider: 'mailchimp'; apiKey: string; listId: string }
	| { provider: 'stripe'; apiKey: string };

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

// ─── Adapter contract ───────────────────────────────────────────────────────

export type FetchPageResult = {
	/** Already-normalized rows; ready for `importBatch`. */
	rows: ImportRow[];
	/** `null` = terminal page; `''` is reserved for "first page" cursor. */
	nextCursor: string | null;
	/** Only when the provider gives one (Mailchimp does, Stripe doesn't). */
	totalEstimate?: number;
};

export interface IntegrationImportProviderModule<K extends IntegrationProviderKind> {
	readonly kind: K;

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
		config: Extract<IntegrationProviderConfig, { provider: K }>,
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
