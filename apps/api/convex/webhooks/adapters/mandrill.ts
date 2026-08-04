/**
 * Mailchimp Transactional (Mandrill) webhook adapter — plan D10.
 *
 * The feedback half of the reference arm: Mandrill is where a migrating team's
 * mail goes while the ramp controller walks traffic onto Owlat's own MTA, so
 * every bounce, complaint, deferral and unsubscribe it sees has to land on the
 * SAME Send rows, the same blocklist and the same (cell, arm) counters our own
 * MTA's feedback does. Anything it drops on the floor is an arm that looks
 * cleaner than it is, which is the one failure mode a measured migration cannot
 * survive.
 *
 * Four things differ from the Resend adapter this is otherwise shaped on:
 *
 *  - **The signature is Twilio's scheme under a different key.** Mandrill signs
 *    base64(HMAC-SHA1(webhook key, exact webhook URL + every decoded POST param
 *    in alphabetical key order, key immediately followed by value)) into
 *    `X-Mandrill-Signature`. That construction is shared with Twilio and lives
 *    once in `webhooks/security.ts`. There is NO timestamp in the signature, so
 *    this layer cannot detect replay — see the batch note below for why that is
 *    acceptable here.
 *  - **The URL is part of the signed string**, which makes the adapter's idea of
 *    its own address load-bearing. Behind a proxy `request.url` is whatever the
 *    hop presented, not what the operator typed into Mandrill, so the deployment's
 *    configured `CONVEX_SITE_URL` is tried first and the request URL second.
 *    Trying both is not a weakening: an attacker who controls the Host header
 *    still cannot produce the HMAC without the key.
 *  - **One request carries a BATCH.** `mandrill_events` is a JSON array of up to
 *    thousands of items, so this is an `InboundBatchAdapter` — it implements
 *    `parseEvents` and the pipeline dispatches the result IN ORDER, where every
 *    other adapter answers with one event. Redelivery of a batch is expected:
 *    the Send lifecycle's reducers are idempotent per transition, so an already
 *    applied event replays as `duplicate`/`terminal` rather than as a second
 *    suppression or a second counter bump.
 *  - **`open` and `click` are dropped** (D3, the Resend precedent). Owlat's own
 *    tracking pixel and link rewriter instrument BOTH arms identically; consuming
 *    Mandrill's counters for one of them would make the `engagement_ratio` ramp
 *    gate compare two different rulers.
 *
 * Mandrill probes a new webhook with an unsigned HEAD request and a signed POST
 * carrying `mandrill_events=[]`. The HEAD is answered by the GET route in
 * `mandrillWebhook.ts` (Convex routes HEAD to the GET handler); the empty batch
 * parses to zero events and the pipeline acknowledges it without dispatching.
 *
 * https://mailchimp.com/developer/transactional/guides/track-respond-activity-webhooks/
 */

import { getOptional } from '../../lib/env';
import {
	constantTimeEqual,
	hmacSha1Base64,
	missingSecretResult,
	parseFormParams,
	urlAndSortedParamsSigningBase,
} from '../security';
import { classifyBounceMessage } from '@owlat/shared/bounceClassification';
import type { InboundBatchAdapter } from '../pipeline';
import type { InboundEvent } from '../types';

/** Wire value written onto reconciled Send rows and read by the dispatcher. */
const MANDRILL_PROVIDER_TYPE = 'mandrill';

/** The form field Mandrill posts its JSON batch in. */
const EVENTS_PARAM = 'mandrill_events';

/**
 * One item of `mandrill_events`. Every field is optional on purpose: the array
 * also carries `sync` items (blacklist/whitelist changes) that have no `msg` at
 * all, and a payload that does not name a message is skipped rather than
 * trusted into a lookup.
 */
interface MandrillEventItem {
	event?: string;
	/** Unix SECONDS, not millis. */
	ts?: number;
	msg?: {
		_id?: string;
		ts?: number;
		email?: string;
		state?: string;
		/** Mandrill's own coarse label, e.g. `bad_mailbox`, `spam_block`. */
		bounce_description?: string;
		/** The receiving MTA's SMTP diagnostic, e.g. `smtp;550 5.1.1 ...`. */
		diag?: string;
		/** Present on `reject`: which blacklist rule refused the address. */
		reject_reason?: string;
	};
}

/**
 * The URLs a signature may legitimately have been computed over, most
 * authoritative first.
 *
 * `CONVEX_SITE_URL` is the deployment's own public HTTP-action origin (the same
 * value `domains/trackingDomains.ts` derives the tracking host from), which is
 * what an operator pastes into Mandrill. `request.url` is the fallback for a
 * deployment that has not set it.
 */
export function mandrillSignedUrlCandidates(requestUrl: string): string[] {
	const candidates: string[] = [];
	const configured = getOptional('CONVEX_SITE_URL');
	if (configured) {
		try {
			const requested = new URL(requestUrl);
			candidates.push(new URL(`${requested.pathname}${requested.search}`, configured).toString());
		} catch {
			// Malformed CONVEX_SITE_URL (or request URL) — fall through to the
			// request URL rather than failing every webhook on a config typo.
		}
	}
	if (!candidates.includes(requestUrl)) candidates.push(requestUrl);
	return candidates;
}

/**
 * Verify `X-Mandrill-Signature` against every candidate URL in constant time.
 *
 * Pure function — env access lives in the adapter wrapper, so the scheme is
 * directly testable. Every candidate is compared with `constantTimeEqual` and
 * the loop runs to completion rather than returning on the first hit, so the
 * time it takes does not describe WHICH candidate matched.
 */
export async function verifyMandrillSignature(
	signedUrls: readonly string[],
	rawBody: string,
	headerSignature: string,
	webhookKey: string
): Promise<boolean> {
	const params = parseFormParams(rawBody);
	let matched = false;
	for (const url of signedUrls) {
		const expected = await hmacSha1Base64(webhookKey, urlAndSortedParamsSigningBase(url, params));
		if (constantTimeEqual(expected, headerSignature)) matched = true;
	}
	return matched;
}

/**
 * Hard vs. soft for a Mandrill bounce.
 *
 * Mandrill's event name is the floor: `hard_bounce` is always hard. A
 * `soft_bounce` is normally taken at its word, with ONE exception — a
 * diagnostic the shared classifier reads as PERMANENT ("user unknown",
 * "5.1.1 ...", "mailbox unavailable") hardens it. That classifier is the same
 * one the MTA bounce engine and the Resend adapter use, it biases toward soft
 * whenever the text is ambiguous, and the Resend adapter's own history is the
 * argument for it: permanent failures that shipped as soft left dead addresses
 * permanently mailable. The upgrade direction is also the only safe one — the
 * blocklist writer explicitly absorbs a soft→hard upgrade on an existing row,
 * and nothing here can ever soften a hard bounce.
 */
export function classifyMandrillBounce(
	event: 'hard_bounce' | 'soft_bounce',
	diagnostic: string
): 'hard' | 'soft' {
	if (event === 'hard_bounce') return 'hard';
	return diagnostic && classifyBounceMessage(diagnostic) === 'hard' ? 'hard' : 'soft';
}

/** The richest free text Mandrill offers about a failure, '' when it offers none. */
function diagnosticOf(item: MandrillEventItem): string {
	return item.msg?.diag || item.msg?.bounce_description || '';
}

/**
 * Event instant in millis. Mandrill reports UNIX SECONDS at the top level and
 * again inside `msg`; a payload carrying neither (or a non-finite value) is
 * stamped with arrival time rather than bucketed at the epoch.
 */
function instantOf(item: MandrillEventItem): number {
	const seconds = item.ts ?? item.msg?.ts;
	return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : Date.now();
}

/**
 * Map ONE Mandrill event onto the normalized union — the D10 table, in code.
 *
 * Returns null for everything Owlat does not act on: `open`/`click` (D3),
 * `sync` blacklist/whitelist notifications, inbound-routing events, unknown
 * future event names, and any item that names no message id (or, for `unsub`,
 * no address) — an event we cannot join is acknowledged, never guessed at.
 */
export function mapMandrillEvent(item: MandrillEventItem): InboundEvent | null {
	const at = instantOf(item);
	const providerMessageId = item.msg?._id;
	const recipient = item.msg?.email;

	switch (item.event) {
		case 'send':
			// Confirms Mandrill accepted the message. For a send whose acceptance
			// was left UNKNOWN by an ambiguous API timeout (D4) this is the event
			// that resolves it: `queued → sent` through the ordinary lifecycle edge,
			// and a row already `sent` records a `duplicate` and changes nothing.
			if (!providerMessageId) return null;
			return {
				kind: 'email.sent',
				providerMessageId,
				at,
				providerType: MANDRILL_PROVIDER_TYPE,
			};
		case 'deferral':
			if (!providerMessageId) return null;
			return {
				kind: 'email.deferred',
				providerMessageId,
				at,
				providerType: MANDRILL_PROVIDER_TYPE,
				...(diagnosticOf(item) ? { reason: diagnosticOf(item) } : {}),
			};
		case 'hard_bounce':
		case 'soft_bounce': {
			if (!providerMessageId) return null;
			const bounceMessage = diagnosticOf(item);
			return {
				kind: 'email.bounced',
				providerMessageId,
				at,
				bounceType: classifyMandrillBounce(item.event, bounceMessage),
				...(bounceMessage ? { bounceMessage } : {}),
				providerType: MANDRILL_PROVIDER_TYPE,
			};
		}
		case 'spam':
			if (!providerMessageId) return null;
			return {
				kind: 'email.complained',
				providerMessageId,
				at,
				providerType: MANDRILL_PROVIDER_TYPE,
			};
		case 'unsub':
			// The one event keyed by ADDRESS rather than by send: Mandrill's
			// unsubscribe surface reports who left, and the dispatcher joins that
			// to a Contact and replays the public one-click path.
			if (!recipient) return null;
			return {
				kind: 'email.unsubscribed',
				recipient,
				at,
				...(providerMessageId ? { providerMessageId } : {}),
				providerType: MANDRILL_PROVIDER_TYPE,
			};
		case 'reject':
			// Mandrill's OWN blacklist refused the address before sending. Terminal
			// and non-bounce, so it takes the `email.failed` edge, which applies no
			// recipient suppression and no reputation penalty here.
			//
			// P2.2 SEAM (D9): the suppression sync that mirrors a Mandrill blacklist
			// hit into `blockedEmails` hangs off the dispatcher's `email.failed`
			// handler and needs two things from this event — the address, carried as
			// `recipient`, and the reason, carried in `errorCode` as
			// `MANDRILL_REJECT[_<REASON>]`. Both are populated here so that piece is
			// a handler change and not a re-parse.
			if (!providerMessageId) return null;
			return {
				kind: 'email.failed',
				providerMessageId,
				at,
				errorMessage: `Mandrill rejected the message${
					item.msg?.reject_reason ? ` (${item.msg.reject_reason})` : ''
				}`,
				errorCode: rejectErrorCode(item.msg?.reject_reason),
				providerType: MANDRILL_PROVIDER_TYPE,
				...(recipient ? { recipient } : {}),
			};
		// `open` / `click` (D3 — first-party tracking only), `sync`, inbound
		// routing, and any event name Mandrill adds later: acknowledged, not acted
		// on. Same posture as the Resend adapter's default branch.
		default:
			return null;
	}
}

/**
 * Stable error code for a reject, e.g. `MANDRILL_REJECT_HARD_BOUNCE`.
 *
 * Normalized (uppercase, non-alphanumerics to `_`, length-capped) because the
 * reason is provider free text on a field the Send row persists.
 */
function rejectErrorCode(reason: string | undefined): string {
	const normalized = (reason ?? '')
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 40);
	return normalized ? `MANDRILL_REJECT_${normalized}` : 'MANDRILL_REJECT';
}

/**
 * Parse the form-encoded body into the batch of events Owlat acts on.
 *
 * Throws (→ 400) when the body carries no `mandrill_events` param or the param
 * is not a JSON array: that is a malformed request, not a batch of nothing.
 */
export function parseMandrillBatch(rawBody: string): InboundEvent[] {
	const raw = parseFormParams(rawBody)[EVENTS_PARAM];
	if (raw === undefined) {
		throw new Error('Mandrill payload missing the mandrill_events parameter');
	}
	const parsed: unknown = JSON.parse(raw);
	if (!Array.isArray(parsed)) {
		throw new Error('Mandrill mandrill_events is not an array');
	}
	const events: InboundEvent[] = [];
	for (const item of parsed as MandrillEventItem[]) {
		const event = mapMandrillEvent(item ?? {});
		if (event) events.push(event);
	}
	return events;
}

export const mandrillAdapter: InboundBatchAdapter = {
	source: 'mandrill',

	async verifySignature(request, rawBody) {
		const webhookKey = getOptional('MANDRILL_WEBHOOK_KEY');
		if (!webhookKey) {
			// 503, not 401 — the same fail-closed posture the Resend adapter takes
			// for an unset secret, so Mandrill retries once the key is configured
			// instead of treating the endpoint as permanently hostile.
			return missingSecretResult('MANDRILL_WEBHOOK_KEY');
		}

		const signature = request.headers.get('x-mandrill-signature');
		if (!signature) {
			return { ok: false, status: 401, reason: 'Missing X-Mandrill-Signature header' };
		}

		const valid = await verifyMandrillSignature(
			mandrillSignedUrlCandidates(request.url),
			rawBody,
			signature,
			webhookKey
		);
		if (!valid) {
			return { ok: false, status: 401, reason: 'Invalid Mandrill signature' };
		}

		return { ok: true };
	},

	// Raw-audit storage mirrors Resend's: the default (store) applies, because a
	// Mandrill batch carries ordinary delivery telemetry rather than the
	// purpose-limited protocol payloads `mta.ts` withholds.
	parseEvents(rawBody): InboundEvent[] {
		return parseMandrillBatch(rawBody);
	},
};
