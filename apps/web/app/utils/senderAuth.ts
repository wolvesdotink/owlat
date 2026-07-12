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
 *
 * This is a no-PSL (Public Suffix List) approximation: we treat the shorter
 * side as an "organizational" domain by pure string suffix. To avoid the
 * degenerate case where a bare public suffix or TLD (`com`, `co.uk`) swallows
 * everything under it (`com` would otherwise "align" with `acme.com`), we
 * refuse suffix alignment when the suffix side is a single label with no dot.
 * A residual, co.uk-shaped risk remains — `foo.co.uk` still suffix-aligns with
 * `co.uk` because `co.uk` has a dot — but that is far narrower than accepting a
 * bare TLD, and closing it properly needs a real PSL we deliberately don't ship
 * here.
 */
function domainsAlign(a: string | undefined, b: string | undefined): boolean {
	const x = norm(a);
	const y = norm(b);
	if (!x || !y) return false;
	if (x === y) return true;
	// Only accept suffix alignment when the SUFFIX side has at least one dot,
	// so a bare public suffix / TLD is never treated as an organizational match.
	if (y.includes('.') && x.endsWith('.' + y)) return true;
	if (x.includes('.') && y.endsWith('.' + x)) return true;
	return false;
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
	const spfDomain = norm(input.envelopeFromDomain);
	const dkimDomain = norm(input.dkimSigningDomain);
	const spfAligned = spfPass && domainsAlign(input.envelopeFromDomain, input.fromDomain);
	const dkimAligned = dkimPass && domainsAlign(input.dkimSigningDomain, input.fromDomain);
	const anyAligned = spfAligned || dkimAligned;
	// "Misaligned" is an impersonation claim, so it MUST rest on an observed
	// differing domain: a check passed AND we know the domain it authenticated
	// AND that domain does not align with the visible From. A pass whose
	// alignment domain is absent (e.g. an older MTA that persisted the verdict
	// without the domain) is NOT misaligned — we simply couldn't tie it to the
	// sender, which is `unauthenticated`, not an accusation.
	const spfMisaligned = spfPass && spfDomain !== '' && !spfAligned;
	const dkimMisaligned = dkimPass && dkimDomain !== '' && !dkimAligned;
	const passedButUnaligned = !anyAligned && (spfMisaligned || dkimMisaligned);

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

	// 3. A check passed for a KNOWN domain that differs from the From header —
	//    the classic impersonation shape. `passedButUnaligned` guarantees at
	//    least one of these domains is non-empty, so `actualDomain` is real.
	if (passedButUnaligned) {
		const actualDomain = (spfMisaligned ? spfDomain : '') || dkimDomain;
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

/**
 * Ingest-computed sender-impersonation heuristics (Sealed Mail A4), persisted on
 * `mailMessages.senderHeuristics`. The whole object is absent when nothing fired
 * — an unremarkable / legacy row contributes no lines rather than a false "all
 * clear". This is the web-side copy of the shape (single source is the Convex
 * `senderHeuristicsValidator`); the boundary keeps its own copy per this app's
 * existing cross-package pattern.
 */
export interface SenderHeuristics {
	isFromDomainSpoofed?: boolean;
	isReplyToMismatch?: boolean;
	isFirstTimeSender?: boolean;
	lookalikeOfContactDomain?: string;
}

/**
 * Turn the ingest heuristics into plain-language SECONDARY lines rendered inside
 * the auth badge's detail (never a second badge). Each line maps 1:1 to a flag
 * that actually fired — the honesty audit again: we only say what was observed.
 * Order runs strongest-signal first (a named look-alike, then a look-alike
 * character set, then a reply-to redirect) and ends with the softest context
 * signal (first contact). Returns [] when nothing fired.
 */
export function deriveSenderHeuristicLines(heuristics: SenderHeuristics | undefined): string[] {
	if (!heuristics) return [];
	const lines: string[] = [];
	const lookalike = heuristics.lookalikeOfContactDomain?.trim();
	if (lookalike) {
		lines.push(`This sender's domain looks like ${lookalike}, but is not it.`);
	}
	if (heuristics.isFromDomainSpoofed) {
		lines.push("The sender's domain uses look-alike characters that imitate another domain.");
	}
	if (heuristics.isReplyToMismatch) {
		lines.push('Replies would go to a different domain than this message claims to be from.');
	}
	if (heuristics.isFirstTimeSender) {
		lines.push("This is the first message you've received from this address.");
	}
	return lines;
}
