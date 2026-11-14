/**
 * How a bounce's typed fields name WHO IT IS ABOUT ({@link BounceCause}): the
 * one rule the MTA's SMTP and DSN classifiers and Convex's relay adapters share,
 * so a `5.7.1` reads the same whichever path reported it.
 *
 * Typed fields only: an RFC 3463 enhanced status code, and a relay's own
 * documented bounce vocabulary. Never the prose around them, which names spam
 * and blocklists in "user unknown" replies as often as in real blocks.
 */

import type { BounceCause } from './smtpBlockCategories';

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
 * the code names neither party (X.0.x, X.3.x, X.4.x, X.5.x, X.6.x).
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
 * The enhanced status code of an SMTP reply quoted as a diagnostic, e.g.
 * `5.7.1` from `smtp; 550 5.7.1 Client host blocked` (the RFC 3464
 * `Diagnostic-Code` form) or from a bare `550 5.7.1 ...`. Anchored to the
 * start of the text after the reply code, so a code that merely appears in the
 * prose is not read.
 */
export function smtpReplyEnhancedCode(diagnostic: string | undefined): string | undefined {
	if (!diagnostic) return undefined;
	return /^[ \t]*(?:smtp[ \t]*;[ \t]*)?[245]\d\d[ \t-]+([245]\.\d{1,3}\.\d{1,3})\b/i.exec(
		diagnostic
	)?.[1];
}

/**
 * The code that decides the cause, from a DSN-style `Status` and the reply the
 * remote server gave. A specific status is authoritative; a generic `X.0.0`
 * names nobody, so the remote server's own code from the diagnostic decides.
 */
export function causeCodeOf(
	status: string | undefined,
	diagnostic: string | undefined
): string | undefined {
	const specific = status !== undefined && /^[245]\.\d{1,3}\.\d{1,3}$/.test(status);
	if (specific && !/^[245]\.0\.0$/.test(status)) return status;
	return smtpReplyEnhancedCode(diagnostic) ?? (specific ? status : undefined);
}

/**
 * What a relay's own typed bounce fields say, in its documented vocabulary:
 *
 *  - `recipient` / `sender`: the relay names the party (a full mailbox, a
 *    content or size rejection, an address on its suppression list);
 *  - `address-failed`: the relay reports the address as permanently failed
 *    without saying why (Amazon SES `Permanent`/`General`, a Mandrill
 *    `hard_bounce`), which is the relay telling us to stop mailing it;
 *  - `unattributed`: neither (a transient or undetermined bounce).
 */
export type RelayBounceVerdict = BounceCause | 'address-failed' | 'unattributed';

/**
 * The cause of a bounce a relay reported. Its own verdict on a named party
 * decides; otherwise an enhanced status code that names a party; otherwise the
 * address is the recipient's problem only when the relay reported it failed.
 *
 * An unattributed bounce is `sender`, the cause that never blocklists and never
 * advances the soft-bounce counter: a relay that cannot say the address is bad
 * must not be able to suppress it, or one reputation block or one DKIM outage
 * at the relay would wipe the list, five sends at a time.
 */
export function relayBounceCause(
	verdict: RelayBounceVerdict,
	enhancedCode: string | undefined
): BounceCause {
	if (verdict === 'recipient' || verdict === 'sender') return verdict;
	const fromCode = enhancedCodeCause(enhancedCode);
	if (fromCode !== undefined) return fromCode;
	return verdict === 'address-failed' ? 'recipient' : 'sender';
}
