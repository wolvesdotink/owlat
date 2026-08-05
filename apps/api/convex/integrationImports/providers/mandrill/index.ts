/**
 * Mandrill (Mailchimp Transactional) **Integration import provider adapter** —
 * the rejection-blacklist carry-over (plan D9, P4.1).
 *
 * The one import in this folder that imports no contacts. A migrating team's
 * Mandrill account holds a rejection blacklist built up over years — every
 * address that hard-bounced, every spam complaint, every address an operator
 * blacklisted by hand — and Mandrill enforces it on every send. Owlat's own MTA
 * does not know a single one of them. Point the ramp controller at that
 * deployment and the own arm starts mailing addresses the reference arm has
 * refused since 2023, earning bounces and complaints the reference arm was
 * quietly spared, on an instrument that reads the difference as "the own MTA is
 * worse". Carrying the list over is what makes the two arms comparable.
 *
 * Three things are worth knowing before changing this file:
 *
 *  - **The credential is env, not config (D2).** Mandrill is a SEND provider;
 *    plan D2 froze send-provider credentials as env-only, so the key comes from
 *    `MANDRILL_API_KEY` — the same variable the send adapter and the webhook
 *    verifier read — and never from the import form. That is why
 *    `IntegrationProviderConfig`'s `mandrill` branch has no fields. It also
 *    means the run is authorized by whoever configured the deployment, which is
 *    the same trust boundary sending through Mandrill already has.
 *  - **The policy table is the webhook's, not a copy.** `rejects/list` and the
 *    `reject` webhook event report the same reasons about the same addresses,
 *    so both go through `mandrillRejectDisposition`. A private mapping here
 *    would be a second table to keep in sync with the first, and the drift
 *    would be silent: an address carried over as `manual` and later re-reported
 *    as `complained` reads as an operator's decision forever.
 *  - **`rejects/list` has no pagination.** Mandrill answers with the whole list
 *    in one response. Handing thousands of addresses to a single mutation is
 *    what the house bounded-transaction rule exists to prevent, so this adapter
 *    pages CLIENT-SIDE: the cursor is an offset into the response and each hop
 *    re-requests the list and returns one window of it. That trades bandwidth
 *    for a bounded write batch, deliberately, and it puts the cursor seam in
 *    place should Mandrill ever add real paging.
 */

import {
	RetryableProviderError,
	type FetchPageResult,
	type IntegrationImportProviderModule,
	type SuppressionRow,
} from '../../_common';
import { getOptional } from '../../../lib/env';
import {
	mandrillRejectCode,
	mandrillRejectDisposition,
} from '../../../webhooks/mandrillRejectSuppression';

const MANDRILL_REJECTS_LIST_URL = 'https://mandrillapp.com/api/1.0/rejects/list';

/**
 * Addresses handed to one `applySuppressionBatch` transaction. Each one costs a
 * blocklist read, a row insert, an audit insert and a mirror schedule, so the
 * window is what keeps a 20k-entry blacklist from arriving as one mutation.
 */
const PAGE_SIZE = 250;

/**
 * Hard stop on the walk. A blacklist this size means something is wrong with
 * the account (or with our reading of the response), and the honest failure is
 * a bounded import that stops, not an unbounded one that re-requests the same
 * list a thousand times.
 */
const MAX_REJECTS = 50_000;

interface MandrillRejectEntry {
	email?: string;
	reason?: string;
	expired?: boolean;
}

export const mandrillProvider: IntegrationImportProviderModule<'mandrill'> = {
	kind: 'mandrill',
	// No `contactSource`: this adapter never produces an `ImportRow`, so the
	// walker never calls `importBatch` for it. A rejection blacklist is a list of
	// people to STOP mailing — turning it into contacts would be exactly backwards.

	validateConfig() {
		// Presence-only, and synchronous, so a deployment without the key is told
		// at the click rather than one scheduler hop later. The value itself never
		// leaves this module.
		if (!getOptional('MANDRILL_API_KEY')) {
			return {
				ok: false,
				reason:
					'MANDRILL_API_KEY is not configured. Add it to the backend environment ' +
					'(the same key the Mandrill send transport uses) and try again.',
			};
		}
		return { ok: true };
	},

	async fetchPage({ cursor }): Promise<FetchPageResult> {
		const offset = cursor === '' ? 0 : parseInt(cursor, 10);
		if (!Number.isFinite(offset) || offset < 0) {
			throw new Error(`Invalid Mandrill rejects cursor: ${cursor}`);
		}

		const apiKey = getOptional('MANDRILL_API_KEY');
		if (!apiKey) {
			throw new Error('MANDRILL_API_KEY is not configured');
		}
		const subaccount = getOptional('MANDRILL_SUBACCOUNT');

		let response: Response;
		try {
			response = await fetch(MANDRILL_REJECTS_LIST_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				// Mandrill convention: the key travels in the JSON body, never in the
				// URL or a header, so it cannot reach a proxy log or an error string
				// built from the request.
				body: JSON.stringify({
					key: apiKey,
					// ALREADY-EXPIRED ENTRIES ARE NOT CARRIED OVER. Mandrill expires
					// some blacklist entries on its own; one that has already lapsed is
					// no longer a suppression THERE, and `blockedEmails` has no expiry,
					// so importing it would be a permanent block built from a lapsed
					// one. Entries that are still live are imported permanently — the
					// conservative direction, documented in `../../suppressions.ts`.
					include_expired: false,
					...(subaccount ? { subaccount } : {}),
				}),
			});
		} catch (err) {
			throw new RetryableProviderError(
				`Network error fetching Mandrill rejects at offset ${offset}: ${
					err instanceof Error ? withoutApiKey(err.message, apiKey) : 'unknown'
				}`
			);
		}

		if (response.status === 429) {
			throw new RetryableProviderError(`Mandrill rate limit (429) at offset ${offset}`);
		}
		if (!response.ok) {
			// Mandrill answers API-level failures (`Invalid_Key`, `PaymentRequired`,
			// `ServiceUnavailable`) with HTTP 500 and a JSON body, so a non-OK status
			// is surfaced with the provider's own message where there is one. Every
			// path is key-redacted: an echoed request body would otherwise put the
			// sending credential into `integrationImports.errors`, which the import
			// UI renders.
			const errorText = await response.text().catch(() => '');
			let errorMessage = `Mandrill API error: ${response.status}`;
			try {
				const errorJson = JSON.parse(errorText) as { message?: string; name?: string };
				errorMessage = errorJson.message || errorJson.name || errorMessage;
			} catch {
				// Non-JSON error response — fall through with status-only message.
			}
			throw new Error(withoutApiKey(errorMessage, apiKey));
		}

		const parsed: unknown = await response.json();
		if (!Array.isArray(parsed)) {
			throw new Error('Mandrill rejects/list did not return a list');
		}
		const entries = parsed as MandrillRejectEntry[];
		if (entries.length > MAX_REJECTS) {
			throw new Error(
				`Mandrill rejects/list returned more than ${MAX_REJECTS} entries; refusing to import`
			);
		}

		const window = entries.slice(offset, offset + PAGE_SIZE);
		const suppressions: SuppressionRow[] = [];
		let suppressionsSkipped = 0;

		for (const entry of window) {
			const email = typeof entry.email === 'string' ? entry.email.toLowerCase() : '';
			if (!email || entry.expired === true) {
				suppressionsSkipped++;
				continue;
			}
			const evidence = mandrillRejectCode(entry.reason);
			const disposition = mandrillRejectDisposition(evidence);
			// `ignore` is every reason that describes OUR account, OUR sending domain
			// or OUR message — `invalid-sender`, `invalid`, `test-mode-limit`,
			// `unsigned` — plus any reason Mandrill adds after this was written. A new
			// reason cannot start suppressing addresses by surprise.
			if (disposition.kind === 'ignore') {
				suppressionsSkipped++;
				continue;
			}
			if (disposition.kind === 'unsubscribe') {
				suppressions.push({ email, reason: 'unsubscribe', evidence });
				continue;
			}
			suppressions.push({
				email,
				reason: disposition.reason,
				...(disposition.reason === 'bounced' ? { bounceType: disposition.bounceType } : {}),
				evidence,
			});
		}

		const nextOffset = offset + PAGE_SIZE;
		const nextCursor: string | null = nextOffset < entries.length ? String(nextOffset) : null;

		return {
			rows: [],
			nextCursor,
			totalEstimate: entries.length,
			...(suppressions.length > 0 ? { suppressions } : {}),
			...(suppressionsSkipped > 0 ? { suppressionsSkipped } : {}),
		};
	},
};

/**
 * Strip the API key out of any text that is about to be persisted or shown.
 *
 * The twin of `withoutApiKey` in the Mandrill SEND adapter, kept local rather
 * than imported because that module is `'use node'` and this one runs in the
 * walker's V8 action. Both exist for the same reason: a provider that echoes a
 * request back inside an error body would otherwise walk the sending credential
 * into a stored error string.
 */
function withoutApiKey(text: string, apiKey: string): string {
	return apiKey.length > 0 ? text.split(apiKey).join('[redacted]') : text;
}
