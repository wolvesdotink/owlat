/**
 * Sender-authentication derivation for the Postbox reader (Sealed Mail A3,
 * flag `senderAuthBadges`).
 *
 * Turns the inbound authentication verdicts persisted at ingest (A1) — SPF,
 * DKIM, DMARC results plus the domains those checks actually authenticated —
 * into ONE honest badge state. The cardinal rule (the honesty audit is a test,
 * not a vibe): a state may never claim more than what was actually checked.
 *
 *   - "verified"        DMARC passed, OR a passing SPF/DKIM check that aligns
 *                       with the visible From domain. Only here do we tell the
 *                       reader the sender is authorized.
 *   - "misaligned"      Some check passed, but for a DIFFERENT domain than the
 *                       From header claims — the classic impersonation shape.
 *   - "failed"          DMARC explicitly failed.
 *   - "unauthenticated" Verdicts were recorded but nothing passed that we can
 *                       tie to the From domain — we simply don't know.
 *   - null (NO badge)   No verdicts at all (a legacy row, or a message from an
 *                       older MTA that never computed them). We fail closed:
 *                       absence is never rendered as "verified".
 */

export type SenderAuthState = 'verified' | 'unauthenticated' | 'misaligned' | 'failed';

/** The raw inbound verdicts + alignment domains persisted at ingest (A1). */
export interface SenderAuthInput {
	/** Domain of the visible `From:` header address. */
	fromDomain?: string;
	spfResult?: string;
	dkimResult?: string;
	dmarcResult?: string;
	dmarcPolicy?: string;
	/** MAIL FROM (envelope) domain — what SPF actually authenticated. */
	envelopeFromDomain?: string;
	/** DKIM `d=` domain — what the signature actually authenticated. */
	dkimSigningDomain?: string;
}

export interface SenderAuthResult {
	state: SenderAuthState;
	/** Short chip label. */
	summary: string;
	/** Expandable plain-language explanation. */
	detail: string;
	tone: 'ok' | 'warn' | 'danger';
	icon: string;
}

function norm(v: string | undefined): string {
	return (v ?? '').trim().toLowerCase();
}

/**
 * Relaxed domain alignment: exact match, or one is the organizational suffix
 * of the other (`mail.acme.com` aligns with `acme.com`). Empty domains never
 * align — an unknown domain can't be asserted to match anything.
 */
function domainsAlign(a: string | undefined, b: string | undefined): boolean {
	const x = norm(a);
	const y = norm(b);
	if (!x || !y) return false;
	if (x === y) return true;
	return x.endsWith('.' + y) || y.endsWith('.' + x);
}

/**
 * Derive the single honest badge state. Pure — no side effects, no I/O — so the
 * honesty audit can enumerate every reachable string against its condition.
 */
export function deriveSenderAuth(input: SenderAuthInput): SenderAuthResult | null {
	const spf = norm(input.spfResult);
	const dkim = norm(input.dkimResult);
	const dmarc = norm(input.dmarcResult);

	// Fail closed: no verdicts recorded at all => no claim, no badge.
	if (!spf && !dkim && !dmarc) return null;

	const fromDomain = norm(input.fromDomain) || 'this sender';

	const spfPass = spf === 'pass';
	const dkimPass = dkim === 'pass';
	const spfAligned = spfPass && domainsAlign(input.envelopeFromDomain, input.fromDomain);
	const dkimAligned = dkimPass && domainsAlign(input.dkimSigningDomain, input.fromDomain);
	const anyAligned = spfAligned || dkimAligned;
	const passedButUnaligned = (spfPass || dkimPass) && !anyAligned;

	// 1. An explicit DMARC failure is the strongest negative signal.
	if (dmarc === 'fail') {
		const strict = norm(input.dmarcPolicy) === 'reject' || norm(input.dmarcPolicy) === 'quarantine';
		return {
			state: 'failed',
			summary: 'Failed sender check',
			detail: strict
				? `This message says it's from ${fromDomain}, but it failed that domain's authentication checks — and ${fromDomain} asks that such messages be rejected. Treat it as suspicious.`
				: `This message says it's from ${fromDomain}, but it failed that domain's authentication checks. Treat it as suspicious.`,
			tone: 'danger',
			icon: 'lucide:shield-x',
		};
	}

	// 2. Authenticated and aligned with the visible sender => the only "verified".
	if (dmarc === 'pass' || anyAligned) {
		return {
			state: 'verified',
			summary: 'Verified sender',
			detail: `We confirmed this message really was sent for ${fromDomain}.`,
			tone: 'ok',
			icon: 'lucide:shield-check',
		};
	}

	// 3. Something passed, but for a different domain than the From header claims.
	if (passedButUnaligned) {
		const actualDomain =
			(spfPass ? norm(input.envelopeFromDomain) : '') ||
			(dkimPass ? norm(input.dkimSigningDomain) : '') ||
			'another domain';
		return {
			state: 'misaligned',
			summary: 'Sender not authorized',
			detail: `Sent by ${actualDomain}, which is not authorized to send for ${fromDomain}.`,
			tone: 'danger',
			icon: 'lucide:shield-alert',
		};
	}

	// 4. Verdicts exist but nothing passed we can tie to the sender.
	return {
		state: 'unauthenticated',
		summary: 'Unverified sender',
		detail: `We couldn't confirm this message really came from ${fromDomain}.`,
		tone: 'warn',
		icon: 'lucide:shield-question',
	};
}
