/**
 * Mailchimp Transactional (Mandrill) webhook adapter.
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
 *    once in `webhooks/security.ts`. There is NO timestamp in the signature and
 *    NO event id in the payload, so the same signed bytes verify every time
 *    they arrive — see the replay note below.
 *  - **The URL is part of the signed string**, which makes the adapter's idea of
 *    its own address load-bearing. Behind a proxy `request.url` is whatever the
 *    hop presented, not what the operator typed into Mandrill, so the deployment's
 *    configured `CONVEX_SITE_URL` is tried first and the request URL second.
 *    Trying both is not a weakening: an attacker who controls the Host header
 *    still cannot produce the HMAC without the key.
 *  - **One request carries a BATCH.** `mandrill_events` is a JSON array of up to
 *    thousands of items, so this is an `InboundBatchParser` — it implements
 *    `parseEvents` and the pipeline dispatches the result IN ORDER, where every
 *    other adapter answers with one event. Redelivery of a batch is expected:
 *    the Send lifecycle's reducers are idempotent per transition, so an already
 *    applied event replays as `duplicate`/`terminal` rather than as a second
 *    suppression or a second counter bump.
 *  - **`open` and `click` are dropped**, as they are for Resend. Owlat's own
 *    tracking pixel and link rewriter instrument BOTH arms identically; consuming
 *    Mandrill's counters for one of them would make the `engagement_ratio` ramp
 *    gate compare two different rulers.
 *
 * Mandrill probes a new webhook with an unsigned HEAD request and a signed POST
 * carrying `mandrill_events=[]`. The HEAD is answered by the GET route on
 * `/webhooks/mandrill` (Convex routes HEAD to the GET handler), which serves
 * `webhookUrlValidationProbe` from `../providerFeedbackHttp.ts`; the empty batch
 * parses to zero events and the pipeline acknowledges it without dispatching.
 *
 * REPLAY (#1228). `reject` (a blocklist mirror) and `unsub` act on an ADDRESS
 * whatever the Send's state, so a replay could undo an operator's unblock or a
 * contact's re-subscribe. For `reject`, `unsub` and `spam`:
 *  - the host refuses a re-add older than an operator's removal
 *    (`blockedEmails.addFromEvent`) and an unsubscribe older than a re-subscribe
 *    (`processUnsubscribeByEmail`), at any event age. That is the protection;
 *  - an event younger than `INBOUND_REPLAY_WINDOW_MS` (7 days) carries a
 *    `replayKey` (`msg._id`, event name, `ts`; no address) that the dispatcher
 *    claims, so it is applied once. An older one, such as a failed batch an
 *    operator replays by hand, relies on the guards alone;
 *  - a `reject` or `unsub` with no `ts`, or one more than five minutes ahead,
 *    cannot be ordered against those guards: the `reject` fails the Send but
 *    suppresses nobody, the `unsub` is dropped. A batch over Mandrill's
 *    documented 1,000 events is refused.
 *
 * https://mailchimp.com/developer/transactional/guides/track-respond-activity-webhooks/
 */

import { getOptional } from '../../lib/env';
import {
	constantTimeEqual,
	hmacSha1Base64,
	parseFormParams,
	urlAndSortedParamsSigningBase,
} from '../security';
import { classifyBounceMessage } from '@owlat/shared/bounceClassification';
import type { InboundBatchParser } from '../pipeline';
import {
	INBOUND_REPLAY_WINDOW_MS,
	type InboundEvent,
	type ProviderSuppression,
	type ProviderSuppressionReason,
} from '../types';

/** Wire value written onto reconciled Send rows and read by the dispatcher. */
const MANDRILL_PROVIDER_TYPE = 'mandrill';

/** The form field Mandrill posts its JSON batch in. */
const EVENTS_PARAM = 'mandrill_events';

/** Mandrill's documented maximum for `mandrill_events`. */
export const MAX_EVENTS_PER_BATCH = 1000;

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
 *
 * RESOLVED HERE, AT REQUEST TIME, and nowhere else. The `mandrill-form` verifier
 * a bundle declares carries no URL list: no deployment URL belongs in a build
 * artifact, so a declared one could only ever be a placeholder — and a contract
 * field that means nothing is a field a third-party bundle would trust.
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

/**
 * The prefix every reject code is built from. Exported so the two doors a
 * reject reaches Owlat through cannot drift apart silently.
 */
export const MANDRILL_REJECT_CODE_PREFIX = 'MANDRILL_REJECT';

/**
 * WHICH REJECT REASONS ARE RECIPIENT TRUTHS — Mandrill's policy, in Mandrill's
 * own adapter, translated into the host's closed suppression vocabulary.
 *
 * A reject is Mandrill's OWN blacklist refusing an address before the message
 * ever reaches a receiver, and it reports ten reasons on one field. Only some of
 * them say anything about the mailbox:
 *
 *  - `hard-bounce` / `soft-bounce` / bare `bounce` — the address itself failed,
 *    repeatedly enough for Mandrill to stop trying. A bare `bounce` carries no
 *    hard/soft qualifier and is read at the strongest reading the event
 *    supports: Mandrill refused to send at all.
 *  - `spam` — this person complained.
 *  - `custom` / `rule` — an OPERATOR (or an account rule) curated this address
 *    onto the blacklist by hand. A human decision, not an observation.
 *  - `unsub` — the person unsubscribed. That is a consent fact with a whole
 *    accounting path of its own, which the host routes it to; the adapter also
 *    maps a first-class `unsub` EVENT there, and the two meeting on one address
 *    is a no-op because the mutation behind them is idempotent.
 *  - `invalid-sender`, `invalid`, `test-mode-limit`, `unsigned`, AND ANY FUTURE
 *    REASON — these describe OUR account, OUR sending domain or OUR message,
 *    not the recipient. They are absent from this table, so they mint no
 *    suppression: the send row moves to `failed` and nothing else happens.
 *    Suppressing on them would let a misconfigured sending domain permanently
 *    blocklist an entire audience one send at a time.
 *
 * WHAT OWLAT DOES about each of these members — which blocklist reason, which
 * bounce classification, which mirror lifetime — is NOT decided here. That is
 * one table for every provider in `webhooks/providerSuppression.ts`, so the
 * consequence of "this mailbox is gone" cannot differ by which relay said so.
 *
 * Keyed on the NORMALIZED code suffix rather than on Mandrill's raw free text:
 * the reason is uppercased and underscored before it ever reaches a persisted
 * field, so `hard-bounce` and a hypothetical `Hard Bounce` arrive as one key.
 */
const REJECT_SUPPRESSION_REASONS: Readonly<Record<string, ProviderSuppressionReason>> = {
	HARD_BOUNCE: 'hard_bounce',
	// Mandrill only blacklists on soft failures after days of retrying, so the
	// address IS evidence — but a recoverable one, which the host mirrors as an
	// expiring backstop entry rather than a permanent one.
	SOFT_BOUNCE: 'soft_bounce',
	BOUNCE: 'hard_bounce',
	SPAM: 'spam_complaint',
	CUSTOM: 'operator_suppressed',
	RULE: 'operator_suppressed',
	UNSUB: 'unsubscribed',
};

/**
 * Stable error code for a reject reason, e.g. `MANDRILL_REJECT_HARD_BOUNCE`.
 *
 * Normalized (uppercase, non-alphanumerics to `_`, length-capped) because the
 * reason is provider free text on a field the Send row persists.
 *
 * Exported because the reject reason reaches Owlat through TWO doors — a
 * `reject` event while the reference arm is live, and the one-off `rejects/list`
 * carry-over at migration time — and the two have to produce the same
 * code for the same reason, or one address reads as two different pieces of
 * evidence depending on which door it came through.
 */
export function mandrillRejectCode(reason: string | undefined): string {
	const normalized = (reason ?? '')
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 40);
	return normalized ? `${MANDRILL_REJECT_CODE_PREFIX}_${normalized}` : MANDRILL_REJECT_CODE_PREFIX;
}

/**
 * The suppression one reject carries, from its error code alone — or undefined
 * when the reason is not about the recipient.
 *
 * Pure, so the whole policy table is testable without a ctx, and shared with the
 * carry-over import so both doors read one table. The provider's own code rides
 * along as `evidence`: an operator looking at the suppression screen sees what
 * Mandrill actually said, not the host's translation of it.
 */
export function mandrillRejectSuppression(errorCode: string): ProviderSuppression | undefined {
	if (!errorCode.startsWith(`${MANDRILL_REJECT_CODE_PREFIX}_`)) return undefined;
	const reason =
		REJECT_SUPPRESSION_REASONS[errorCode.slice(MANDRILL_REJECT_CODE_PREFIX.length + 1)];
	return reason ? { reason, evidence: errorCode } : undefined;
}

/** The richest free text Mandrill offers about a failure, '' when it offers none. */
function diagnosticOf(item: MandrillEventItem): string {
	return item.msg?.diag || item.msg?.bounce_description || '';
}

/**
 * The instant Mandrill stamped on the event, in millis, or undefined when it
 * stamped none. Mandrill reports UNIX SECONDS at the top level and again inside
 * `msg`.
 */
function providerInstantOf(item: MandrillEventItem): number | undefined {
	const seconds = item.ts ?? item.msg?.ts;
	return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/**
 * Event instant in millis. A payload carrying no timestamp is stamped with
 * arrival time rather than bucketed at the epoch.
 */
function instantOf(item: MandrillEventItem): number {
	return providerInstantOf(item) ?? Date.now();
}

/** How far ahead of our clock a Mandrill `ts` may be and still count as fresh. */
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/** Mandrill message ids are 32 hex characters; anything else gets no key. */
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Whether the event can be ordered against an operator's decision, which an
 * ADDRESS-keyed effect requires: Mandrill stamped it, and not in the future. An
 * unstamped event would read as "now" and beat every earlier decision.
 */
function isOrderable(item: MandrillEventItem, now: number): boolean {
	const at = providerInstantOf(item);
	return at !== undefined && at <= now + MAX_FUTURE_SKEW_MS;
}

/**
 * The replay identity of one event: `<event>:<msg._id>:<ts>`, as close to an
 * event id as Mandrill offers, with no address in it. Undefined for an event
 * that is not orderable, is older than `INBOUND_REPLAY_WINDOW_MS`, or names no
 * usable message id.
 */
export function mandrillReplayKey(
	item: MandrillEventItem,
	now: number = Date.now()
): string | undefined {
	const id = item.msg?._id;
	const at = providerInstantOf(item);
	if (!item.event || !id || !MESSAGE_ID_PATTERN.test(id) || !isOrderable(item, now)) {
		return undefined;
	}
	if (at === undefined || at < now - INBOUND_REPLAY_WINDOW_MS) return undefined;
	return `mandrill:${item.event}:${id}:${at}`;
}

/**
 * Map ONE Mandrill event onto the normalized union — the mapping table, in code.
 *
 * Returns null for everything Owlat does not act on: `open`/`click`,
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
			// was left UNKNOWN by an ambiguous API timeout this is the event
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
		case 'spam': {
			if (!providerMessageId) return null;
			// Mandrill events are per recipient, so `msg.email` is the complainer.
			// It rides along for a complaint whose id matches no send (#1194).
			// A replayed complaint is a lifecycle duplicate already; the key, or
			// past its window the event time, keeps it from being counted again as
			// unresolved feedback.
			const replayKey = mandrillReplayKey(item);
			return {
				kind: 'email.complained',
				providerMessageId,
				at,
				providerType: MANDRILL_PROVIDER_TYPE,
				...(recipient ? { recipient } : {}),
				...(replayKey ? { replayKey } : {}),
				sameReportByEventTime: true,
			};
		}
		case 'unsub': {
			// The one event keyed by ADDRESS rather than by send: Mandrill's
			// unsubscribe surface reports who left, and the dispatcher joins that
			// to a Contact and replays the public one-click path. It is ordered
			// against a later re-subscribe, so an unstamped one is dropped (#1228).
			if (!recipient || !isOrderable(item, Date.now())) return null;
			const replayKey = mandrillReplayKey(item);
			return {
				kind: 'email.unsubscribed',
				recipient,
				at,
				...(providerMessageId ? { providerMessageId } : {}),
				providerType: MANDRILL_PROVIDER_TYPE,
				...(replayKey ? { replayKey } : {}),
			};
		}
		case 'reject': {
			// Mandrill's OWN blacklist refused the address before sending. Terminal
			// and non-bounce, so it takes the `email.failed` edge: the send row
			// leaves "sending" without a bounce's reputation penalty.
			//
			// The recipient half of that same fact — Mandrill's blacklist holds
			// this address, which the own arm has to mirror or the two arms stop
			// mailing the same population — is minted HERE, as a normalized
			// `suppression`, because deciding what `reject_reason: 'custom'` means is
			// knowing Mandrill. What the host DOES with it is the host's table.
			// Absent for every reason that describes our account rather than the
			// person, which is how those reasons suppress nobody.
			//
			// The suppression acts on an address whatever the Send's state, so it
			// rides only on an orderable event (#1228). An unstamped reject still
			// fails its Send, which is idempotent on its own.
			if (!providerMessageId) return null;
			const errorCode = mandrillRejectCode(item.msg?.reject_reason);
			const replayKey = mandrillReplayKey(item);
			const suppression = isOrderable(item, Date.now())
				? mandrillRejectSuppression(errorCode)
				: undefined;
			return {
				kind: 'email.failed',
				providerMessageId,
				at,
				errorMessage: `Mandrill rejected the message${
					item.msg?.reject_reason ? ` (${item.msg.reject_reason})` : ''
				}`,
				errorCode,
				providerType: MANDRILL_PROVIDER_TYPE,
				...(recipient ? { recipient } : {}),
				...(suppression ? { suppression } : {}),
				...(replayKey ? { replayKey } : {}),
			};
		}
		// `open` / `click` (first-party tracking only), `sync`, inbound
		// routing, and any event name Mandrill adds later: acknowledged, not acted
		// on. Same posture as the Resend adapter's default branch.
		default:
			return null;
	}
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
	if (parsed.length > MAX_EVENTS_PER_BATCH) {
		throw new Error(`Mandrill batch exceeds ${MAX_EVENTS_PER_BATCH} events`);
	}
	const events: InboundEvent[] = [];
	for (const item of parsed as MandrillEventItem[]) {
		const event = mapMandrillEvent(item ?? {});
		if (event) events.push(event);
	}
	return events;
}

export const mandrillAdapter: InboundBatchParser<'mandrill'> = {
	source: 'mandrill',

	// Raw-audit storage mirrors Resend's: the default (store) applies, because a
	// Mandrill batch carries ordinary delivery telemetry rather than the
	// purpose-limited protocol payloads `mta.ts` withholds.
	parseEvents(rawBody): InboundEvent[] {
		return parseMandrillBatch(rawBody);
	},
};
