/**
 * Mandrill's sender-domain API — the two calls this adapter makes.
 *
 *   POST /api/1.0/senders/add-domain    — idempotent; registers the domain on
 *                                         the account and answers with its
 *                                         current state.
 *   POST /api/1.0/senders/check-domain  — re-tests the published DNS from
 *                                         Mandrill's own view and answers with
 *                                         the same shape.
 *
 * `senders/verify-domain` is deliberately NOT called. It sends a verification
 * MAIL to a mailbox on the domain and returns nothing we could act on; it is a
 * step the OPERATOR takes (or replaces with the `mandrill_verify` TXT record
 * this module reads back), not a side effect a background sweep should have.
 * Triggering third-party mail to a customer's mailbox from a cron is not an
 * idempotent check.
 *
 * Three OUTCOMES, not a boolean and not an exception: `ok` (Mandrill told us
 * something), `auth_failed` (our credential is wrong — terminal until an
 * operator fixes it) and `unavailable` (Mandrill did not answer — evidence of
 * nothing). The caller must be able to tell the last two apart, because one
 * FAILS an identity and the other must leave it exactly as it was; a thrown
 * Error would collapse them into "something went wrong".
 */

import { getOptional } from '../../../lib/env';
import { postMandrill } from '../../../lib/sendProviders/mandrill/client';
import { categorizeMandrillError } from '../../../lib/sendProviders/mandrill/errors';
import { EmailErrorCode } from '../../../lib/sendProviders/types';

/** Upper bound on one sender-domain call. */
const MANDRILL_DOMAIN_API_TIMEOUT_MS = 15_000;
const TIMEOUT_MESSAGE = 'Mandrill sender-domain call timed out';

/** The provider state both endpoints answer with. */
export interface MandrillDomainState {
	readonly domain: string;
	readonly spf: { isValid: boolean; error?: string };
	readonly dkim: { isValid: boolean; error?: string };
	readonly isValidSigning: boolean;
	/** Ownership verification, absent until Mandrill records one. */
	readonly verifiedAt?: number;
	readonly verifyTxtKey?: string;
}

type MandrillDomainCall =
	| { outcome: 'ok'; state: MandrillDomainState }
	| { outcome: 'auth_failed'; error: string }
	| { outcome: 'unavailable'; error: string };

/** Mandrill's per-record verdict object. */
interface RawRecordState {
	readonly valid?: unknown;
	readonly error?: unknown;
}

interface RawDomainState {
	readonly domain?: unknown;
	readonly spf?: RawRecordState;
	readonly dkim?: RawRecordState;
	readonly valid_signing?: unknown;
	readonly verified_at?: unknown;
	readonly verify_txt_key?: unknown;
}

/**
 * `"2013-01-01 15:30:27"` — Mandrill's timestamps are UTC with no zone marker,
 * so the `T`/`Z` are supplied here rather than letting the runtime read them as
 * local time (which would move an ownership timestamp by hours, and on the
 * wrong side of a freshness bound that is the point of storing it).
 */
function parseMandrillTimestamp(value: unknown): number | undefined {
	if (typeof value !== 'string' || value.trim() === '') return undefined;
	const parsed = Date.parse(`${value.trim().replace(' ', 'T')}Z`);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function readRecordState(raw: RawRecordState | undefined): { isValid: boolean; error?: string } {
	const isValid = raw?.valid === true;
	const error = typeof raw?.error === 'string' && raw.error.trim() !== '' ? raw.error : undefined;
	return { isValid, ...(error !== undefined ? { error } : {}) };
}

/**
 * Read the domain object. `null` when the body is not one at all — a proxy
 * error page or an HTML redirect answered 200, which is "no answer", never
 * "every record is invalid" (that would fail a working identity on a gateway
 * hiccup).
 */
function readDomainState(payload: unknown, domain: string): MandrillDomainState | null {
	if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
	const raw = payload as RawDomainState;
	if (raw.spf === undefined && raw.dkim === undefined && typeof raw.domain !== 'string') {
		return null;
	}
	const verifiedAt = parseMandrillTimestamp(raw.verified_at);
	const verifyTxtKey =
		typeof raw.verify_txt_key === 'string' && raw.verify_txt_key.trim() !== ''
			? raw.verify_txt_key.trim()
			: undefined;
	return {
		domain: typeof raw.domain === 'string' && raw.domain !== '' ? raw.domain : domain,
		spf: readRecordState(raw.spf),
		dkim: readRecordState(raw.dkim),
		isValidSigning: raw.valid_signing === true,
		...(verifiedAt !== undefined ? { verifiedAt } : {}),
		...(verifyTxtKey !== undefined ? { verifyTxtKey } : {}),
	};
}

async function callSenderDomainEndpoint(
	endpoint: 'add-domain' | 'check-domain',
	domain: string
): Promise<MandrillDomainCall> {
	// A missing key is an AUTH failure, not an outage: nothing will change until
	// an operator configures one, so the identity should say so rather than
	// retry a request it cannot make every hour forever.
	const apiKey = getOptional('MANDRILL_API_KEY');
	if (!apiKey) {
		return { outcome: 'auth_failed', error: 'MANDRILL_API_KEY is not configured' };
	}

	try {
		// `postMandrill` owns the base URL, the timeout and abort, and redacts the
		// key (which travels in the body) from every error it returns or throws.
		const result = await postMandrill(
			`/senders/${endpoint}`,
			{ key: apiKey, domain },
			{
				timeoutMs: MANDRILL_DOMAIN_API_TIMEOUT_MS,
				timeoutMessage: TIMEOUT_MESSAGE,
				failureLabel: 'Mandrill sender-domain call failed',
			}
		);

		if (!result.ok) {
			const error = result.error.surfaced;
			// ONE place knows how Mandrill spells a credential failure — the send
			// adapter's taxonomy — so a new spelling is learned by both paths at
			// once. Everything else (5xx, quota, an unparseable gateway page) is an
			// outage from this module's point of view: no evidence either way.
			return categorizeMandrillError(result.error.classifyText, result.status) ===
				EmailErrorCode.AUTH_FAILED
				? { outcome: 'auth_failed', error }
				: { outcome: 'unavailable', error };
		}

		const state = readDomainState(result.payload, domain);
		return state === null
			? { outcome: 'unavailable', error: 'Mandrill returned no sender-domain state' }
			: { outcome: 'ok', state };
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown Mandrill error';
		return { outcome: 'unavailable', error: message };
	}
}

/**
 * Register the domain on the Mandrill account. Idempotent — Mandrill answers an
 * already-registered domain with its current state rather than an error, which
 * is what lets a re-registration (or a second deployment pointing at the same
 * account) be a no-op instead of a failure.
 */
export async function addSenderDomain(domain: string): Promise<MandrillDomainCall> {
	return await callSenderDomainEndpoint('add-domain', domain);
}

/** Ask Mandrill to re-test the domain's published DNS and report what it sees. */
export async function checkSenderDomain(domain: string): Promise<MandrillDomainCall> {
	return await callSenderDomainEndpoint('check-domain', domain);
}
