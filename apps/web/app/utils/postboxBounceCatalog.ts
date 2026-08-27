/**
 * Plain-language bounce catalog (plan idea 2).
 *
 * What the backend stores for a failed recipient is the receiver's own wire
 * text — "550 5.7.1 Unauthenticated email from acme.example is not accepted due
 * to domain's DMARC policy". That string hides the two things the sender
 * actually needs: whose problem this is, and what to do about it. This module is
 * the one place that answers both.
 *
 * TWO HALVES, DELIBERATELY SEPARATE:
 *
 *  1. `bounceCause()` — a pure classifier over what we stored. It reads the RFC
 *     3464 enhanced status code first (`Status: 5.1.1`, or the same code inline
 *     in the text), because that is the machine-readable field receivers are
 *     required to speak, and only falls back to the shared free-text patterns
 *     when no code is present. It deliberately does NOT re-implement the MTA's
 *     vendor-prose regexes (`apps/mta/src/intelligence/smtpClassifier.ts`):
 *     those belong where the SMTP session is, and a second copy here would be a
 *     second classifier free to disagree with the first.
 *  2. `BOUNCE_CATALOG` — the registry proper. Every `SmtpFailureCategory` the
 *     shipped classifier can emit (`@owlat/shared/smtpBlockCategories`) plus the
 *     three DSN outcomes that vocabulary has no name for, mapped to a cause
 *     line, a FAULT attribution, and exactly one next action.
 *
 * Module scope, so it never calls `useI18n`: every line is a catalog key (or a
 * `{key, params}` pair), resolved by the component that renders it. Same
 * convention as `utils/senderAlignment.ts`.
 *
 * FAULT ATTRIBUTION is the point of the whole exercise. A user staring at a red
 * row wants to know whether they broke something or the world did:
 *  - `your-setup`   — this instance's sending identity is the problem (DMARC,
 *                     SPF, PTR, missing auth). Resending changes nothing.
 *  - `their-mailbox`— the address or the receiving mailbox is the problem (no
 *                     such user, over quota, refused the content).
 *  - `temporary`    — nobody is at fault yet; the receiver asked us to wait.
 *
 * Nothing here claims more than the evidence supports: an unrecognised failure
 * lands on `unknown`, which says so and offers the raw text rather than
 * inventing a diagnosis.
 */

import {
	HARD_BOUNCE_PATTERNS,
	SOFT_BOUNCE_PATTERNS,
} from '@owlat/shared/bounceClassification';
import type { SmtpFailureCategory } from '@owlat/shared/smtpBlockCategories';
import type { HealthTone } from '~/utils/healthTone';
import type { LocalizedText } from '~/utils/readinessGate';

/**
 * Whose problem the failure is. Three values, because three is what a person can
 * act on: fix my setup, fix the address, or wait.
 */
export type BounceFault = 'your-setup' | 'their-mailbox' | 'temporary';

/**
 * The catalog's cause vocabulary: every category the shipped SMTP classifier can
 * emit, plus the three per-recipient DSN outcomes it has no name for.
 *
 * `SmtpFailureCategory` exists to answer "is the receiver refusing this SENDING
 * IDENTITY?" for the ramp gate, so it never needed a word for the single most
 * common personal-mail bounce — the address does not exist. These three fill
 * that gap without touching the shared vocabulary, which two deployables pin
 * themselves to.
 */
export type BounceCause =
	| SmtpFailureCategory
	/** 5.1.x — no such user / bad address. The classic hard bounce. */
	| 'mailbox_unknown'
	/** 5.2.3 / 5.3.4 — the message itself was too big for the receiver. */
	| 'message_too_large'
	/** Any other 4.x — a temporary failure we cannot name more precisely. */
	| 'temporary_failure';

export interface BounceExplanation {
	cause: BounceCause;
	fault: BounceFault;
	tone: HealthTone;
	/** One sentence on what happened, in the reader's language. A catalog key. */
	summary: LocalizedText;
	/** Exactly one next action. A catalog key; `null` when there is nothing to do. */
	action: LocalizedText | null;
	/**
	 * Whether resending to this recipient could plausibly succeed WITHOUT
	 * changing anything else. Drives the delivery strip's resend affordance: a
	 * DMARC rejection is not worth retrying until the setup changes, while a
	 * greylist or a full mailbox is.
	 */
	isRetryable: boolean;
}

const KEY = 'shared.bounceCatalog';

/** One entry per cause. Total by construction — see the exhaustiveness test. */
export const BOUNCE_CATALOG: Record<BounceCause, Omit<BounceExplanation, 'cause'>> = {
	mailbox_unknown: {
		fault: 'their-mailbox',
		tone: 'error',
		summary: `${KEY}.mailboxUnknown.summary`,
		action: `${KEY}.mailboxUnknown.action`,
		isRetryable: false,
	},
	mailbox_full: {
		fault: 'their-mailbox',
		tone: 'warning',
		summary: `${KEY}.mailboxFull.summary`,
		action: `${KEY}.mailboxFull.action`,
		isRetryable: true,
	},
	message_too_large: {
		fault: 'your-setup',
		tone: 'warning',
		summary: `${KEY}.messageTooLarge.summary`,
		action: `${KEY}.messageTooLarge.action`,
		isRetryable: false,
	},
	content_rejected: {
		fault: 'their-mailbox',
		tone: 'error',
		summary: `${KEY}.contentRejected.summary`,
		action: `${KEY}.contentRejected.action`,
		isRetryable: false,
	},
	policy_rejected: {
		fault: 'your-setup',
		tone: 'error',
		summary: `${KEY}.policyRejected.summary`,
		action: `${KEY}.policyRejected.action`,
		isRetryable: false,
	},
	auth_required: {
		fault: 'your-setup',
		tone: 'error',
		summary: `${KEY}.authRequired.summary`,
		action: `${KEY}.authRequired.action`,
		isRetryable: false,
	},
	gmail_ip_identity: {
		fault: 'your-setup',
		tone: 'error',
		summary: `${KEY}.gmailIpIdentity.summary`,
		action: `${KEY}.gmailIpIdentity.action`,
		isRetryable: false,
	},
	gmail_tls_required: {
		fault: 'your-setup',
		tone: 'error',
		summary: `${KEY}.gmailTlsRequired.summary`,
		action: `${KEY}.gmailTlsRequired.action`,
		isRetryable: false,
	},
	greylisted: {
		fault: 'temporary',
		tone: 'neutral',
		summary: `${KEY}.greylisted.summary`,
		action: null,
		isRetryable: true,
	},
	rate_limited: {
		fault: 'temporary',
		tone: 'warning',
		summary: `${KEY}.rateLimited.summary`,
		action: `${KEY}.rateLimited.action`,
		isRetryable: true,
	},
	gmail_rate_limited: {
		fault: 'temporary',
		tone: 'warning',
		summary: `${KEY}.rateLimited.summary`,
		action: `${KEY}.rateLimited.action`,
		isRetryable: true,
	},
	yahoo_ts03: {
		fault: 'your-setup',
		tone: 'error',
		summary: `${KEY}.yahooDeferred.summary`,
		action: `${KEY}.yahooDeferred.action`,
		isRetryable: false,
	},
	yahoo_tss04: {
		fault: 'temporary',
		tone: 'warning',
		summary: `${KEY}.rateLimited.summary`,
		action: `${KEY}.rateLimited.action`,
		isRetryable: true,
	},
	microsoft_resource_throttle: {
		fault: 'temporary',
		tone: 'warning',
		summary: `${KEY}.rateLimited.summary`,
		action: `${KEY}.rateLimited.action`,
		isRetryable: true,
	},
	network_error: {
		fault: 'temporary',
		tone: 'warning',
		summary: `${KEY}.networkError.summary`,
		action: `${KEY}.networkError.action`,
		isRetryable: true,
	},
	temporary_failure: {
		fault: 'temporary',
		tone: 'warning',
		summary: `${KEY}.temporaryFailure.summary`,
		action: `${KEY}.temporaryFailure.action`,
		isRetryable: true,
	},
	unknown: {
		fault: 'temporary',
		tone: 'warning',
		summary: `${KEY}.unknown.summary`,
		action: `${KEY}.unknown.action`,
		isRetryable: true,
	},
};

/** The stored evidence a failed recipient carries. Both fields are optional. */
export interface BounceEvidence {
	/** The receiver's wire text, as stored (`bounceMessage`). */
	bounceMessage?: string | null;
	/** The failure code the MTA reported alongside it (`errorCode`). */
	errorCode?: string | null;
}

/** RFC 3464 enhanced status code — `Status:`-anchored, then loose. */
const STATUS_FIELD = /^[ \t]*Status:[ \t]*([245])\.(\d{1,3})\.(\d{1,3})\b/im;
const LOOSE_CODE = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/;

type EnhancedCode = { klass: number; subject: number; detail: number };

function readEnhancedCode(text: string): EnhancedCode | null {
	const match = STATUS_FIELD.exec(text) ?? LOOSE_CODE.exec(text);
	if (!match) return null;
	return { klass: Number(match[1]), subject: Number(match[2]), detail: Number(match[3]) };
}

/**
 * The cause for an enhanced status code, or null when the code is real but says
 * nothing we can name (the caller then falls through to the text patterns).
 *
 * The mapping follows the IANA enhanced-status-code registry, and the ORDER
 * matters: `5.2.2` (over quota) is checked before the generic 5.2.x, and
 * `5.7.x` splits into "we are not authorised to send this" (your setup) versus
 * "your content was refused" (theirs) because those two lead to opposite next
 * actions.
 */
function causeForCode(code: EnhancedCode, text: string): BounceCause | null {
	const { klass, subject, detail } = code;
	if (klass === 2) return null; // a success code is not a failure
	if (klass === 4) {
		// 4.2.2 over quota, 4.7.1 greylisting, 4.4.x routing/connection, 4.3.x
		// receiver resources. Everything else temporary but unnamed.
		if (subject === 2 && detail === 2) return 'mailbox_full';
		if (subject === 7 && detail === 1) return 'greylisted';
		if (subject === 4) return 'network_error';
		if (subject === 3) return 'rate_limited';
		// A 4.7.x that names a sender-identity fact (a missing PTR record, a DMARC
		// or SPF verdict) is a SETUP problem wearing a temporary code — Gmail's
		// `421 4.7.23 … does not have a PTR record` is the canonical case, and it
		// does not get better by waiting. Only the identity wording promotes it;
		// `4.7.28 … unusual rate of unsolicited mail` stays rate pressure.
		if (subject === 7 && POLICY_PATTERNS.test(text)) return 'policy_rejected';
		return 'temporary_failure';
	}
	// klass === 5, permanent.
	if (subject === 1) return 'mailbox_unknown';
	if (subject === 2 && detail === 2) return 'mailbox_full';
	if (subject === 2 && detail === 3) return 'message_too_large';
	if (subject === 3 && detail === 4) return 'message_too_large';
	if (subject === 7) {
		// 5.7.1 is overloaded: receivers use it both for "your message looks like
		// spam" and for "your sending identity is not authorised". The number alone
		// cannot separate them, so hand the decision to the wording pass rather
		// than pick one and be wrong half the time.
		if (detail === 1) return null;
		// 5.7.0 / 5.7.8 / 5.7.9 are authentication; 5.7.23 / 5.7.25 / 5.7.26 are
		// sender-policy (SPF / PTR / unauthenticated).
		if (detail === 0 || detail === 8 || detail === 9) return 'auth_required';
		return 'policy_rejected';
	}
	// A permanent code we have no name for (5.4.x routing, 5.5.x protocol …).
	// The wording pass gets a turn before we admit we don't know.
	return null;
}

/** Sender-identity wording, which is what separates a 5.7.1 policy fail from spam. */
const POLICY_PATTERNS =
	/dmarc|spf|dkim|sender policy|not authori[sz]ed|unauthenticated|ptr record|reverse dns|domainkeys/i;
/** Content/reputation wording on the same codes. */
const CONTENT_PATTERNS =
	/spam|unsolicited|bulk|blocked using|blacklist|blocklist|spamhaus|content rejected|virus|phishing/i;
/** Size wording, which carries no reliable enhanced code on many receivers. */
const SIZE_PATTERNS = /message (?:size|too (?:large|big))|exceeds (?:size|maximum)|too large/i;
/** Explicit over-quota wording. */
const QUOTA_PATTERNS = /over quota|quota exceeded|mailbox (?:is )?full|insufficient storage/i;

/**
 * Classify one stored failure into a catalog cause.
 *
 * Precedence, deliberately: the enhanced status code first (it is the field
 * receivers are required to speak), then the wording — except on the two codes
 * that are genuinely ambiguous in the wild (`5.7.1`, and any `unknown`), where
 * the wording is the only way to tell "your identity is refused" from "your
 * content is refused". Nothing recognised at all returns `unknown`, which the
 * catalog renders as "we don't know" plus the raw text.
 */
export function bounceCause(evidence: BounceEvidence): BounceCause {
	const text = `${evidence.errorCode ?? ''} ${evidence.bounceMessage ?? ''}`.trim();
	if (text.length === 0) return 'unknown';

	const code = readEnhancedCode(text);
	const coded = code ? causeForCode(code, text) : null;
	if (coded !== null) return coded;

	// Wording pass. Ordered by how specific the signal is: an explicit policy or
	// size statement beats a generic spam word, which beats a quota word.
	if (POLICY_PATTERNS.test(text)) return 'policy_rejected';
	if (SIZE_PATTERNS.test(text)) return 'message_too_large';
	if (CONTENT_PATTERNS.test(text)) return 'content_rejected';
	if (QUOTA_PATTERNS.test(text)) return 'mailbox_full';

	// The shared hard/soft patterns are the last resort — the same lists the MTA
	// and the Resend adapter fall back to, so a text all three see is read the
	// same way by all three. `HARD` here means "the address is bad", which is the
	// only thing that list actually asserts.
	if (HARD_BOUNCE_PATTERNS.test(text) && !SOFT_BOUNCE_PATTERNS.test(text)) {
		return 'mailbox_unknown';
	}
	if (SOFT_BOUNCE_PATTERNS.test(text)) return 'temporary_failure';
	// Recognised as permanent but not as anything in particular. `unknown` is the
	// honest answer — it renders as "we couldn't read this" plus the raw text,
	// which beats attributing the failure to a party we have no evidence about.
	return 'unknown';
}

/**
 * The full explanation for one stored failure: cause, fault, tone, one line, one
 * action. This is the copy inside the delivery strip's red row.
 */
export function explainBounce(evidence: BounceEvidence): BounceExplanation {
	const cause = bounceCause(evidence);
	return { cause, ...BOUNCE_CATALOG[cause] };
}

/** Catalog key for a fault attribution, for the strip's "…on your side" line. */
export function bounceFaultKey(fault: BounceFault): string {
	return `${KEY}.fault.${
		fault === 'your-setup' ? 'yourSetup' : fault === 'their-mailbox' ? 'theirMailbox' : 'temporary'
	}`;
}
