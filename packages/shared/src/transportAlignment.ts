/**
 * Outbound DMARC-alignment guard — does the delivery TRANSPORT authenticate mail
 * in a way that aligns with the From-domain the operator actually sends from?
 *
 * DMARC (RFC 7489 §3.1) passes only when at least one of SPF or DKIM both
 * authenticates AND *aligns* with the RFC5322.From domain. The built-in Owlat
 * MTA signs DKIM per-From-domain (`d=` == the From domain) and can stamp a
 * per-domain return-path, so its mail aligns by construction. A generic SMTP
 * relay (Mailgun/Postmark/SendGrid/Brevo/custom) is different: unless the
 * operator has set the relay up to sign as their own domain, the relay signs and
 * bounces as ITS OWN domain (`sendgrid.net`, `mailgun.org`, …), which shares no
 * Organizational Domain with `acme.com` — every DMARC check then fails and the
 * mail is treated as spoofed.
 *
 * This module is the ONE place that rule lives, so the delivery-readiness panel
 * (instance-level) and the From-pickers (per-identity) can't drift. It reuses
 * {@link isSpfAligned} from `spfAlignment.ts` for the actual Organizational-Domain
 * comparison rather than forking it.
 *
 * Honesty: a `misaligned` verdict is only returned when BOTH authenticated
 * identities we can see are foreign to the From-domain — i.e. there is no
 * unchecked identity left that could still rescue alignment. When the relay's
 * signing/bounce domains are simply unknown (the operator hasn't declared them),
 * the verdict is `unknown`, never a claimed problem we didn't verify.
 */

import { isSpfAligned } from './spfAlignment';

/** The send-transport kinds Owlat supports (mirrors the backend `SendProviderKind`). */
export type SendTransportKind = 'mta' | 'ses' | 'resend' | 'smtp';

/**
 * A single From-domain's alignment against the active transport:
 *  - `aligned`    — at least one authenticated identity shares the From-domain's
 *                   Organizational Domain, so DMARC can pass.
 *  - `misaligned` — every authenticated identity we can see is foreign, so DMARC
 *                   fails and receivers can treat the mail as spoofed.
 *  - `unknown`    — the transport's signing/bounce identities aren't declared, so
 *                   alignment can't be confirmed either way.
 */
export type OutboundAlignmentState = 'aligned' | 'misaligned' | 'unknown';

/**
 * The effective outbound identities the active transport stamps on a message.
 * Non-secret DNS-facing values (never credentials).
 */
export interface OutboundTransportFacts {
	kind: SendTransportKind;
	/**
	 * The effective envelope return-path (bounce / MAIL FROM) domain, or `null`
	 * when the transport uses a per-From-domain return path (the built-in MTA
	 * default). SPF authenticates this identity.
	 */
	returnPathDomain: string | null;
	/**
	 * The effective DKIM signing domain (the `d=` tag), or `null` when the
	 * transport signs per-From-domain (the built-in MTA default). DKIM
	 * authenticates this identity.
	 */
	dkimDomain: string | null;
}

/** The alignment verdict for one From-domain plus a plain-language reason. */
export interface FromAlignmentResult {
	state: OutboundAlignmentState;
	/**
	 * One plain-language sentence for the reader when the mail isn't cleanly
	 * aligned (misaligned or unknown); `null` when aligned. No acronyms beyond the
	 * SPF/DKIM/DMARC wording the delivery surfaces already use.
	 */
	reason: string | null;
}

/** true ⇒ aligns, false ⇒ foreign, null ⇒ can't tell (identity undeclared). */
type IdentityAlignment = true | false | null;

/**
 * Alignment of one authenticated identity (DKIM `d=` or the return-path domain).
 * An undeclared identity (`null`) aligns for the built-in MTA — it signs/bounces
 * per-From-domain — but is genuinely unknown for a relay (the relay controls it).
 */
function identityAlignment(
	identityDomain: string | null,
	fromDomain: string,
	mtaPerDomainDefault: boolean
): IdentityAlignment {
	if (identityDomain == null) {
		return mtaPerDomainDefault ? true : null;
	}
	return isSpfAligned(identityDomain, fromDomain);
}

/** The foreign identity to name in a misalignment reason (DKIM preferred). */
function foreignIdentity(facts: OutboundTransportFacts): string | null {
	return facts.dkimDomain ?? facts.returnPathDomain ?? null;
}

/**
 * Does mail from `fromDomain`, sent through this transport, align for DMARC?
 *
 * Returns `aligned` as soon as one authenticated identity shares the From-domain's
 * Organizational Domain (relaxed alignment, DMARC's default). Returns `misaligned`
 * only when BOTH the DKIM and return-path identities are known AND both are
 * foreign — the honest bar for asserting a delivery problem. Any remaining
 * uncertainty (a relay whose identities aren't declared) is `unknown`.
 */
export function checkFromAlignment(
	fromDomain: string,
	facts: OutboundTransportFacts
): FromAlignmentResult {
	const from = fromDomain.trim().toLowerCase().replace(/\.$/, '');
	if (!from) {
		return { state: 'unknown', reason: null };
	}

	const perDomain = facts.kind === 'mta';
	const dkim = identityAlignment(facts.dkimDomain, from, perDomain);
	const returnPath = identityAlignment(facts.returnPathDomain, from, perDomain);

	// DMARC passes when at least one authenticated identity aligns.
	if (dkim === true || returnPath === true) {
		return { state: 'aligned', reason: null };
	}

	// Both identities are known AND both foreign: DMARC cannot pass.
	if (dkim === false && returnPath === false) {
		const foreign = foreignIdentity(facts);
		return {
			state: 'misaligned',
			reason: foreign
				? `This transport signs and bounces mail as “${foreign}”, which isn’t part of “${from}”. Mailboxes will see the sending address and the signature disagree, so this mail can be treated as spam.`
				: `This transport doesn’t authenticate as “${from}”, so this mail can be treated as spam.`,
		};
	}

	// A relay whose signing/bounce identities aren't declared: we can't confirm
	// alignment, so we say so rather than claim a problem we didn't verify.
	return {
		state: 'unknown',
		reason: `We can’t confirm this relay signs mail as “${from}”. If it signs as its own domain, mailboxes may treat your mail as spam — check your relay’s DKIM setup.`,
	};
}

/** The instance-level roll-up the delivery-readiness panel renders. */
export interface OutboundAlignmentSummary {
	/** At least one configured From-domain is definitely misaligned. */
	misaligned: boolean;
	/** The From-domains that came back `misaligned`, in input order. */
	misalignedDomains: string[];
	/** Guidance for the first misaligned domain, or `null` when none is misaligned. */
	reason: string | null;
}

/**
 * Roll the per-domain verdict up across every configured From-domain for the
 * instance-level readiness gate. Only definite `misaligned` domains raise the
 * warning — `unknown` domains (undeclared relay identities) don't, so a
 * correctly-set-up deployment is never nagged for an unverifiable relay.
 */
export function summarizeOutboundAlignment(
	fromDomains: readonly string[],
	facts: OutboundTransportFacts
): OutboundAlignmentSummary {
	const misalignedDomains: string[] = [];
	let reason: string | null = null;
	for (const domain of fromDomains) {
		const result = checkFromAlignment(domain, facts);
		if (result.state === 'misaligned') {
			misalignedDomains.push(domain);
			if (reason == null) {
				reason = result.reason;
			}
		}
	}
	return {
		misaligned: misalignedDomains.length > 0,
		misalignedDomains,
		reason,
	};
}
