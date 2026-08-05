/**
 * Mandrill `reject` → Owlat suppression sync (plan D9, the "ongoing sync" half).
 *
 * A reject is Mandrill's OWN blacklist refusing an address before the message
 * ever reaches a receiver. During a measured migration that list is years of
 * accumulated recipient truth the reference arm still enforces and the own arm
 * knows nothing about — so without this, the ramp controller would move traffic
 * onto an MTA that happily mails addresses Mandrill has refused since 2023, and
 * the own arm would earn the bounces and complaints the reference arm was
 * quietly spared. Mirroring the hit into `blockedEmails` (and, through the
 * shipped `scheduleSuppressionMirror`, into the MTA's Redis backstop) is what
 * keeps the two arms sending to the same population.
 *
 * Its own module rather than an inline branch in `dispatcher.ts` for the reason
 * `complaintDispatch.ts` is: the dispatcher is a routing TABLE, and the mapping
 * below is a policy that needs a docblock next to it (CONVENTIONS.md — split a
 * feature rather than growing a file).
 *
 * WHAT IS AND IS NOT A RECIPIENT TRUTH is the whole decision here. Mandrill
 * reports ten reject reasons on one field, and only some of them say anything
 * about the mailbox:
 *
 *  - `hard-bounce` / `soft-bounce` — the address itself failed, repeatedly
 *    enough for Mandrill to stop trying. Mailbox evidence: suppress as
 *    `bounced`, carrying the hard/soft distinction the MTA mirror turns into a
 *    permanent vs. expiring backstop entry (`toMtaSuppressionReason`).
 *  - `spam` — this person complained. Suppress as `complained`, the same class
 *    an FBL report earns.
 *  - `custom` / `rule` — an OPERATOR (or an account rule) curated this address
 *    onto the blacklist by hand. That is a human decision, not an observation,
 *    so it maps to `manual` — the one reason whose MTA mirror expires and whose
 *    presence on the suppression screen reads as "someone put this here".
 *  - `unsub` — the person unsubscribed. Owlat has a whole consent path for
 *    that (membership delete, opt-out stamp, campaign counter, webhook fanout);
 *    a blocklist row would record the outcome while skipping the accounting, so
 *    this routes to the unsubscribe path INSTEAD. The adapter already maps a
 *    first-class `unsub` EVENT there; this covers the same fact arriving as a
 *    reject, and the unsubscribe mutation is idempotent, so the two paths
 *    meeting on one address is a no-op, not a double count.
 *  - `invalid-sender`, `invalid`, `test-mode-limit`, `unsigned`, and any future
 *    reason — these describe OUR account, OUR sending domain or OUR message,
 *    not the recipient. Suppressing on them would let a misconfigured sending
 *    domain permanently blocklist an entire audience one send at a time. They
 *    move the Send row to `failed` (which the dispatcher already did) and
 *    nothing else.
 */

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import type { InboundEventOf } from './types';

/** The wire value the Mandrill adapter stamps on every event it emits. */
const MANDRILL_PROVIDER_TYPE = 'mandrill';

/**
 * The prefix `webhooks/adapters/mandrill.ts` builds every reject code from.
 * Exported so the adapter's normalizer and this reader cannot drift apart
 * silently — a rename breaks the test that pins them against each other.
 */
export const MANDRILL_REJECT_CODE_PREFIX = 'MANDRILL_REJECT';

/** What a reject reason means for the recipient, if anything. */
export type MandrillRejectDisposition =
	| { readonly kind: 'suppress'; readonly reason: 'bounced'; readonly bounceType: 'hard' | 'soft' }
	| { readonly kind: 'suppress'; readonly reason: 'complained' | 'manual' }
	| { readonly kind: 'unsubscribe' }
	| { readonly kind: 'ignore' };

/**
 * Reject reason (as normalized into the error code) → disposition.
 *
 * Keyed on the NORMALIZED suffix rather than on Mandrill's raw free text: the
 * adapter uppercases and underscores the reason before it ever reaches a
 * persisted field, so `hard-bounce` and a hypothetical `Hard Bounce` arrive as
 * one key. Anything absent from this table is ignored by construction — a new
 * Mandrill reason cannot start suppressing addresses by surprise.
 */
const REJECT_DISPOSITIONS: Readonly<Record<string, MandrillRejectDisposition>> = {
	HARD_BOUNCE: { kind: 'suppress', reason: 'bounced', bounceType: 'hard' },
	// Mandrill only blacklists on soft failures after days of retrying, so the
	// address IS evidence — but a recoverable one, which is why it rides the
	// soft classification the MTA mirror expires (the same shape the shipped
	// soft-bounce escalation writes in `feedbackReducers.ts`).
	SOFT_BOUNCE: { kind: 'suppress', reason: 'bounced', bounceType: 'soft' },
	// A reason of plain `bounce` (no hard/soft qualifier) is taken at the
	// strongest reading the event supports: Mandrill refused to send at all.
	BOUNCE: { kind: 'suppress', reason: 'bounced', bounceType: 'hard' },
	SPAM: { kind: 'suppress', reason: 'complained' },
	CUSTOM: { kind: 'suppress', reason: 'manual' },
	RULE: { kind: 'suppress', reason: 'manual' },
	UNSUB: { kind: 'unsubscribe' },
};

/**
 * Stable error code for a reject reason, e.g. `MANDRILL_REJECT_HARD_BOUNCE`.
 *
 * Normalized (uppercase, non-alphanumerics to `_`, length-capped) because the
 * reason is provider free text on a field the Send row persists.
 *
 * Lives here, next to the table it keys, rather than in the webhook adapter that
 * used to own it: the reject reason reaches Owlat through TWO doors — a `reject`
 * event while the reference arm is live, and the one-off `rejects/list`
 * carry-over at migration time (P4.1) — and the two have to produce the same
 * code for the same reason or the same address reads as two different pieces of
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
 * What Owlat does about one reject, from its error code alone.
 *
 * Pure, so the whole policy table is testable without a ctx — and so the
 * dispatcher's branch stays a single call.
 */
export function mandrillRejectDisposition(errorCode: string): MandrillRejectDisposition {
	if (!errorCode.startsWith(`${MANDRILL_REJECT_CODE_PREFIX}_`)) return { kind: 'ignore' };
	const reason = errorCode.slice(MANDRILL_REJECT_CODE_PREFIX.length + 1);
	return REJECT_DISPOSITIONS[reason] ?? { kind: 'ignore' };
}

/**
 * Sync one `email.failed` event's suppression consequence, if it has one.
 *
 * Called by the dispatcher BEFORE the lifecycle transition, on the
 * `complaintDispatch` principle: the recipient-protecting write runs first, so
 * a failure in the bookkeeping half can never be the reason an address Mandrill
 * refused stays mailable on ours.
 *
 * Three guards, all of which have to hold: the event has to come from the
 * Mandrill adapter (`providerType`), carry a reject code, and name an address.
 * The address is UNTRUSTED provider telemetry — it is acted on because the
 * SIGNED webhook said Mandrill rejected it, never because the field was
 * present. Everything else acknowledges and does nothing.
 */
export async function syncMandrillReject(
	ctx: ActionCtx,
	e: InboundEventOf<'email.failed'>
): Promise<void> {
	if (e.providerType !== MANDRILL_PROVIDER_TYPE || !e.recipient) return;
	const disposition = mandrillRejectDisposition(e.errorCode);
	if (disposition.kind === 'ignore') return;

	if (disposition.kind === 'unsubscribe') {
		await ctx.runMutation(internal.delivery.unsubscribeQueries.processUnsubscribeByEmail, {
			email: e.recipient,
		});
		return;
	}

	await ctx.runMutation(internal.blockedEmails.addFromEvent, {
		email: e.recipient,
		reason: disposition.reason,
		...(disposition.reason === 'bounced' ? { bounceType: disposition.bounceType } : {}),
		provenance: {
			provider: MANDRILL_PROVIDER_TYPE,
			source: 'webhook' as const,
			evidence: e.errorCode,
		},
	});
}
