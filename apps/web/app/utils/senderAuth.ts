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
 *   - "forwarded"       DMARC failed (a mailing list / forwarder broke the
 *                       author's signature), but a TRUSTED forwarder's validated
 *                       ARC chain (RFC 8617) attested the original passed, so the
 *                       backend rescued it (`dmarcOverride === 'arc'`). Honest:
 *                       we vouch via the forwarder we chose to trust, not the
 *                       original signature. Reachable ONLY when the backend set
 *                       the override — an ordinary message can never render it.
 *   - "misaligned"      Some check passed, but for a DIFFERENT domain than the
 *                       From header claims — the classic impersonation shape.
 *   - "failed"          DMARC explicitly failed.
 *   - "unauthenticated" Verdicts were recorded but nothing passed that we can
 *                       tie to the From domain — we simply don't know.
 *   - null (NO badge)   No verdicts at all (a legacy row, or a message from an
 *                       older MTA that never computed them). We fail closed:
 *                       absence is never rendered as "verified".
 *
 * Module scope, so nothing here calls `useI18n`: every string it hands back is a
 * catalog KEY, or a `{ key, params }` pair where the message names a domain. The
 * badge resolves them with `t()` at render time, in the active locale. A sender
 * whose From domain is unknown gets its OWN message rather than a translated
 * noun spliced into a parameter — a phrase handed to `t()` as an interpolation
 * would never be translated.
 */

export type SenderAuthState =
	| 'verified'
	| 'forwarded'
	| 'unauthenticated'
	| 'misaligned'
	| 'failed';

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
	/**
	 * Inbound-auth override the backend applied (Sealed Mail A5). `'arc'` means a
	 * DMARC fail was RESCUED because a trusted forwarder's validated ARC chain
	 * attested the original passed. Absent on the ordinary path.
	 */
	dmarcOverride?: string;
	/** The trusted forwarder's `d=` that was honoured for the rescue, if named. */
	arcSealer?: string;
}

/**
 * A translatable sentence this module hands to whoever renders it: a bare
 * catalog key, or a key plus the values its message interpolates.
 */
export type SenderAuthText = string | { key: string; params?: Record<string, string> };

export interface SenderAuthResult {
	state: SenderAuthState;
	/** Short chip label — a catalog key. */
	summary: string;
	/** Expandable plain-language explanation — a key or a `{ key, params }` pair. */
	detail: SenderAuthText;
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

	// EMPTY IS ITS OWN BRANCH, not a fallback noun: "this sender" is copy, and a
	// copy string passed as an interpolation parameter would ship untranslated.
	const fromDomain = norm(input.fromDomain);
	const named = fromDomain !== '';

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

	// 1. Trusted-forwarder ARC rescue (Sealed Mail A5). DMARC failed (a mailing
	//    list / forwarder broke the author's DKIM), but the backend confirmed a
	//    TRUSTED forwarder's validated ARC chain attested the original passed and
	//    set `dmarcOverride === 'arc'`. We surface an honest "verified via
	//    forwarder" state — the trust rests on the forwarder we chose, not the
	//    original signature. This precedes the DMARC-fail branch precisely because
	//    a rescued fail must NOT read as suspicious. Reachable ONLY when the
	//    backend set the override.
	if (norm(input.dmarcOverride) === 'arc') {
		const sealer = norm(input.arcSealer);
		return {
			state: 'forwarded',
			summary: 'shared.senderAuth.forwarded.summary',
			detail: sealer
				? {
						key: named
							? 'shared.senderAuth.forwarded.namedSealer'
							: 'shared.senderAuth.forwarded.namedSealerUnknownSender',
						params: { sealer, domain: fromDomain },
					}
				: {
						key: named
							? 'shared.senderAuth.forwarded.anySealer'
							: 'shared.senderAuth.forwarded.anySealerUnknownSender',
						params: { domain: fromDomain },
					},
			tone: 'ok',
			icon: 'lucide:shield-check',
		};
	}

	// 2. An explicit DMARC failure is the strongest negative signal.
	if (dmarc === 'fail') {
		const strict = norm(input.dmarcPolicy) === 'reject' || norm(input.dmarcPolicy) === 'quarantine';
		return {
			state: 'failed',
			summary: 'shared.senderAuth.failed.summary',
			detail: {
				key: strict
					? named
						? 'shared.senderAuth.failed.strict'
						: 'shared.senderAuth.failed.strictUnknownSender'
					: named
						? 'shared.senderAuth.failed.detail'
						: 'shared.senderAuth.failed.detailUnknownSender',
				params: { domain: fromDomain },
			},
			tone: 'danger',
			icon: 'lucide:shield-x',
		};
	}

	// 3. Authenticated and aligned with the visible sender => the only "verified".
	if (dmarc === 'pass' || anyAligned) {
		return {
			state: 'verified',
			summary: 'shared.senderAuth.verified.summary',
			detail: {
				key: named
					? 'shared.senderAuth.verified.detail'
					: 'shared.senderAuth.verified.detailUnknownSender',
				params: { domain: fromDomain },
			},
			tone: 'ok',
			icon: 'lucide:shield-check',
		};
	}

	// 4. A check passed for a KNOWN domain that differs from the From header —
	//    the classic impersonation shape. `passedButUnaligned` guarantees at
	//    least one of these domains is non-empty, so `actualDomain` is real.
	if (passedButUnaligned) {
		const actualDomain = (spfMisaligned ? spfDomain : '') || dkimDomain;
		return {
			state: 'misaligned',
			summary: 'shared.senderAuth.misaligned.summary',
			detail: {
				key: named
					? 'shared.senderAuth.misaligned.detail'
					: 'shared.senderAuth.misaligned.detailUnknownSender',
				params: { sender: actualDomain, domain: fromDomain },
			},
			tone: 'danger',
			icon: 'lucide:shield-alert',
		};
	}

	// 5. Verdicts exist but nothing passed we can tie to the sender.
	return {
		state: 'unauthenticated',
		summary: 'shared.senderAuth.unauthenticated.summary',
		detail: {
			key: named
				? 'shared.senderAuth.unauthenticated.detail'
				: 'shared.senderAuth.unauthenticated.detailUnknownSender',
			params: { domain: fromDomain },
		},
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
 * signal (first contact). Returns [] when nothing fired. Each line is a catalog
 * key (or a `{ key, params }` pair) the badge resolves at render time.
 */
export function deriveSenderHeuristicLines(
	heuristics: SenderHeuristics | undefined
): SenderAuthText[] {
	if (!heuristics) return [];
	const lines: SenderAuthText[] = [];
	const lookalike = heuristics.lookalikeOfContactDomain?.trim();
	if (lookalike) {
		lines.push({ key: 'shared.senderAuth.heuristics.lookalike', params: { domain: lookalike } });
	}
	if (heuristics.isFromDomainSpoofed) {
		lines.push('shared.senderAuth.heuristics.spoofedCharacters');
	}
	if (heuristics.isReplyToMismatch) {
		lines.push('shared.senderAuth.heuristics.replyToMismatch');
	}
	if (heuristics.isFirstTimeSender) {
		lines.push('shared.senderAuth.heuristics.firstTimeSender');
	}
	return lines;
}
