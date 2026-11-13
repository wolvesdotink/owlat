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
 * X.7.x codes that are about the recipient's mailbox rather than our identity:
 * a disabled account (X.7.13, RFC 7372) and a mailbox or domain that changed
 * owner (X.7.17 / X.7.18, RFC 7293). The rest of X.7 is security or policy
 * applied to the sender.
 */
const RECIPIENT_SECURITY_DETAILS: ReadonlySet<number> = new Set([13, 17, 18]);

/**
 * X.1.x codes that describe the SENDER's address (RFC 3463 §3.2): X.1.7 bad
 * sender mailbox syntax, X.1.8 bad sender system address. Every other X.1.x
 * is about the destination address.
 */
const SENDER_ADDRESS_DETAILS: ReadonlySet<number> = new Set([7, 8]);

/**
 * What an enhanced status code alone says about the cause, or `undefined` when
 * the code names neither party (X.0.x, X.3.x, X.4.x, X.5.x, X.6.x). Shared by
 * the live SMTP path and the asynchronous DSN classifier, so both read a code
 * the same way.
 */
export function enhancedCodeCause(enhancedCode: string | undefined): BounceCause | undefined {
	if (enhancedCode === undefined) return undefined;
	const match = /^[245]\.(\d{1,3})\.(\d{1,3})$/.exec(enhancedCode);
	if (!match) return undefined;
	const subject = Number(match[1]);
	const detail = Number(match[2]);
	if (subject === 1) return SENDER_ADDRESS_DETAILS.has(detail) ? 'sender' : 'recipient';
	if (subject === 2) return 'recipient';
	if (subject === 7) return RECIPIENT_SECURITY_DETAILS.has(detail) ? 'recipient' : 'sender';
	return undefined;
}

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
