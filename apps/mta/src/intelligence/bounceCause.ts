/**
 * Who an SMTP refusal is about: our sending identity, or the recipient.
 *
 * A bounce about the sender ends the attempt like any other, and still trains
 * the breaker, the throttle, warming and the ramp, but it must never suppress
 * the address: one blocklisting or one DKIM outage would otherwise wipe every
 * recipient at the affected providers off the list.
 *
 * The verdict reads typed fields only, never the reply text: the protocol phase
 * the reply came in, the RFC 3463 enhanced status code, and the category the
 * SMTP classifier already assigned.
 */

import type { SmtpPhase } from '@owlat/smtp-client';
import { SMTP_BLOCK_CATEGORIES, type BounceCause } from '@owlat/shared/smtpBlockCategories';
import { enhancedCodeCause } from '@owlat/shared/bounceCause';
import type { SmtpFailureCategory } from './smtpClassifier.js';
import type { DispatchOutcome } from '../dispatch/outcomeClassification.js';

/**
 * Phases that end before the server has accepted a recipient. A reply in one of
 * them cannot be about the recipient, whatever code it carries.
 */
const PRE_RECIPIENT_PHASES: ReadonlySet<SmtpPhase> = new Set<SmtpPhase>([
	'connect',
	'greeting',
	'ehlo',
	'starttls',
	'auth',
	'mail',
]);

/**
 * The cause of a refusal the receiver answered with.
 *
 * Precedence, most authoritative first:
 *  1. a reply given before RCPT TO was accepted is about the sender;
 *  2. an enhanced code that names a party decides;
 *  3. a block category (spam verdict, sender policy, IP identity) is the
 *     sender's;
 *  4. anything else is the recipient's.
 *
 * The code outranks the category because the category is matched from prose: a
 * `5.1.1` whose text happens to say "spam" is still an unknown user. A refusal
 * with no phase is synthetic (no MX, Null MX, no SMTPUTF8) and stays the
 * recipient's.
 */
export function smtpRefusalCause(refusal: {
	phase: SmtpPhase | undefined;
	enhancedCode: string | undefined;
	category: SmtpFailureCategory;
}): BounceCause {
	if (refusal.phase !== undefined && PRE_RECIPIENT_PHASES.has(refusal.phase)) return 'sender';
	const fromCode = enhancedCodeCause(refusal.enhancedCode);
	if (fromCode !== undefined) return fromCode;
	return SMTP_BLOCK_CATEGORIES.has(refusal.category) ? 'sender' : 'recipient';
}

/**
 * The cause of a dispatch outcome: a server refusal is judged by
 * {@link smtpRefusalCause}; everything else (a delivery, a connection failure,
 * an ambiguous drop) is no refusal of the sender. Read both where a refusal ends
 * the message and where a retried refusal outlives the message's age limit.
 */
export function dispatchOutcomeCause(outcome: DispatchOutcome): BounceCause {
	if (outcome.kind !== 'hard_bounce' && outcome.kind !== 'deferred') return 'recipient';
	return smtpRefusalCause({
		phase: outcome.smtpPhase,
		enhancedCode: outcome.enhancedCode,
		category: outcome.classification.category,
	});
}
