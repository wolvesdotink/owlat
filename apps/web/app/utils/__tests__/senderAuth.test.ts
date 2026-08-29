/**
 * Sender-authentication derivation (Sealed Mail A3) — the honesty audit.
 *
 * Six fixtures pin every reachable state to the exact verdict shape that
 * produces it, and the "legacy row" case proves absence NEVER renders as
 * verified (fail-closed). The verbatim misaligned string is asserted here.
 */
import { describe, it, expect } from 'vitest';
import {
	deriveReplyRisk,
	deriveSenderAuth,
	deriveSenderHeuristicLines,
	deriveSenderRisk,
	deriveSenderRowMarker,
	senderAuthInputOf,
	senderRiskInputOf,
	type SenderAuthInput,
	type SenderAuthText,
} from '../senderAuth';
import { createTestI18n } from '~/__tests__/i18n';

/** The derivation carries catalog keys, so the audit renders them in English. */
const { t } = createTestI18n().global;
const render = (text: SenderAuthText) =>
	typeof text === 'string' ? t(text) : t(text.key, text.params ?? {});

describe('deriveSenderAuth', () => {
	it('aligned pass → verified', () => {
		const input: SenderAuthInput = {
			fromDomain: 'acme.com',
			spfResult: 'pass',
			dkimResult: 'pass',
			dmarcResult: 'pass',
			dmarcPolicy: 'reject',
			envelopeFromDomain: 'acme.com',
			dkimSigningDomain: 'acme.com',
		};
		const result = deriveSenderAuth(input);
		expect(result?.state).toBe('verified');
		expect(result?.tone).toBe('ok');
	});

	it('verified is reachable via an aligned SPF pass even without a DMARC result', () => {
		const result = deriveSenderAuth({
			fromDomain: 'acme.com',
			spfResult: 'pass',
			envelopeFromDomain: 'mail.acme.com',
		});
		expect(result?.state).toBe('verified');
	});

	it('no auth (verdicts present, nothing passes) → unauthenticated', () => {
		const result = deriveSenderAuth({
			fromDomain: 'acme.com',
			spfResult: 'none',
			dkimResult: 'none',
			dmarcResult: 'none',
		});
		expect(result?.state).toBe('unauthenticated');
		expect(result?.tone).toBe('warn');
	});

	it('unaligned pass → misaligned, with the verbatim impersonation copy', () => {
		const result = deriveSenderAuth({
			fromDomain: 'acme.com',
			spfResult: 'pass',
			envelopeFromDomain: 'sketchy.example',
		});
		expect(result?.state).toBe('misaligned');
		expect(result?.tone).toBe('danger');
		expect(render(result!.detail)).toBe(
			'Sent by sketchy.example, which is not authorized to send for acme.com.'
		);
	});

	it('pass with NO alignment domain → unauthenticated, never misaligned', () => {
		// An older MTA (A1 "older MTA" case) persists an SPF pass without the
		// envelope domain. We never observed a differing domain, so we may not
		// claim impersonation — only that we couldn't tie the pass to the sender.
		const result = deriveSenderAuth({
			fromDomain: 'acme.com',
			spfResult: 'pass',
		});
		expect(result?.state).toBe('unauthenticated');
		expect(result?.tone).toBe('warn');
	});

	it('a bare public suffix envelope domain does NOT align into verified', () => {
		// domainsAlign must refuse a single-label suffix, so an SPF pass whose
		// MAIL FROM is itself a TLD can't masquerade as an organizational match.
		const result = deriveSenderAuth({
			fromDomain: 'acme.com',
			spfResult: 'pass',
			envelopeFromDomain: 'com',
		});
		expect(result?.state).toBe('misaligned');
	});

	it('DMARC fail + p=none → failed', () => {
		const result = deriveSenderAuth({
			fromDomain: 'acme.com',
			spfResult: 'fail',
			dkimResult: 'fail',
			dmarcResult: 'fail',
			dmarcPolicy: 'none',
		});
		expect(result?.state).toBe('failed');
		expect(result?.tone).toBe('danger');
	});

	it('DMARC fail + p=reject → failed', () => {
		const result = deriveSenderAuth({
			fromDomain: 'acme.com',
			spfResult: 'fail',
			dkimResult: 'fail',
			dmarcResult: 'fail',
			dmarcPolicy: 'reject',
		});
		expect(result?.state).toBe('failed');
	});

	it('legacy row (all verdicts absent) → NO badge, never verified (fail closed)', () => {
		const result = deriveSenderAuth({ fromDomain: 'acme.com' });
		expect(result).toBeNull();
	});

	it('a DMARC fail can never be masked into verified by an unaligned pass', () => {
		const result = deriveSenderAuth({
			fromDomain: 'acme.com',
			spfResult: 'pass',
			envelopeFromDomain: 'evil.example',
			dmarcResult: 'fail',
			dmarcPolicy: 'reject',
		});
		expect(result?.state).toBe('failed');
	});

	// Sealed Mail A5 — the trusted-forwarder "verified via forwarder" state. The
	// copy is asserted VERBATIM (honesty audit): this state is reachable ONLY when
	// the backend set `dmarcOverride === 'arc'`, and it precedes the fail branch so
	// a rescued DMARC fail never reads as suspicious.
	it('DMARC fail rescued by a trusted forwarder → forwarded, with the verbatim named copy', () => {
		const result = deriveSenderAuth({
			fromDomain: 'author.example',
			spfResult: 'fail',
			dkimResult: 'fail',
			dmarcResult: 'fail',
			dmarcPolicy: 'quarantine',
			dmarcOverride: 'arc',
			arcSealer: 'lists.sourceforge.net',
		});
		expect(result?.state).toBe('forwarded');
		expect(result?.tone).toBe('ok');
		expect(t(result!.summary)).toBe('Verified via forwarder');
		expect(render(result!.detail)).toBe(
			'A forwarding service you trust (lists.sourceforge.net) confirmed this message really was sent for author.example before passing it on. Its own checks broke in forwarding, which is normal for mailing lists.'
		);
	});

	it('forwarded state falls back to un-named copy when no sealer is recorded', () => {
		const result = deriveSenderAuth({
			fromDomain: 'author.example',
			dmarcResult: 'fail',
			dmarcPolicy: 'quarantine',
			dmarcOverride: 'arc',
		});
		expect(result?.state).toBe('forwarded');
		expect(render(result!.detail)).toBe(
			'A forwarding service you trust confirmed this message really was sent for author.example before passing it on. Its own checks broke in forwarding, which is normal for mailing lists.'
		);
	});

	it('the forwarder state is unreachable without the backend override (an ordinary DMARC fail stays failed)', () => {
		const result = deriveSenderAuth({
			fromDomain: 'author.example',
			dmarcResult: 'fail',
			dmarcPolicy: 'quarantine',
		});
		expect(result?.state).toBe('failed');
	});
});

describe('deriveSenderHeuristicLines', () => {
	it('returns [] when the heuristics object is absent', () => {
		expect(deriveSenderHeuristicLines(undefined)).toEqual([]);
	});

	it('returns [] when nothing fired', () => {
		expect(deriveSenderHeuristicLines({})).toEqual([]);
	});

	it('emits strongest-signal-first verbatim lines for each fired flag', () => {
		expect(
			deriveSenderHeuristicLines({
				lookalikeOfContactDomain: 'paypal.com',
				isFromDomainSpoofed: true,
				isReplyToMismatch: true,
				isFirstTimeSender: true,
			}).map(render)
		).toEqual([
			"This sender's domain looks like paypal.com, but is not it.",
			"The sender's domain uses look-alike characters that imitate another domain.",
			'Replies would go to a different domain than this message claims to be from.',
			"This is the first message you've received from this address.",
		]);
	});

	it('names the resembled domain in the look-alike line', () => {
		expect(
			deriveSenderHeuristicLines({ lookalikeOfContactDomain: 'stripe.com' }).map(render)
		).toEqual(["This sender's domain looks like stripe.com, but is not it."]);
	});

	it('ignores a blank look-alike domain', () => {
		expect(deriveSenderHeuristicLines({ lookalikeOfContactDomain: '  ' })).toEqual([]);
	});

	it('emits only the first-time line when that is all that fired', () => {
		expect(deriveSenderHeuristicLines({ isFirstTimeSender: true }).map(render)).toEqual([
			"This is the first message you've received from this address.",
		]);
	});
});

/**
 * The danger-only surfaces (UX plan ideas 51 + 56). Same honesty rule: a flagged
 * shape must rest on something that was actually observed, and the SILENT cases
 * matter as much as the loud ones — `unauthenticated` is not an accusation, and
 * neither is a legacy row.
 */
describe('deriveSenderRisk', () => {
	it('flags an explicit DMARC failure with the badge’s own sentence', () => {
		const risk = deriveSenderRisk({
			auth: { fromDomain: 'acme.com', dmarcResult: 'fail', dmarcPolicy: 'reject' },
		});
		expect(risk.map((l) => l.reason)).toEqual(['failed']);
		expect(render(risk[0]!.text)).toBe(
			"This message says it's from acme.com, but it failed that domain's authentication checks — and acme.com asks that such messages be rejected. Treat it as suspicious."
		);
	});

	it('flags the misaligned shape and names the domain that actually sent it', () => {
		const risk = deriveSenderRisk({
			auth: { fromDomain: 'acme.com', spfResult: 'pass', envelopeFromDomain: 'bulk.example' },
		});
		expect(risk.map((l) => l.reason)).toEqual(['misaligned']);
		expect(render(risk[0]!.text)).toBe(
			'Sent by bulk.example, which is not authorized to send for acme.com.'
		);
	});

	it('stacks the heuristics onto the verdict, strongest evidence first', () => {
		const risk = deriveSenderRisk({
			auth: { fromDomain: 'brightpath-finance.co', dmarcResult: 'fail' },
			heuristics: { lookalikeOfContactDomain: 'brightpath.com', isReplyToMismatch: true },
		});
		expect(risk.map((l) => l.reason)).toEqual(['failed', 'lookalike', 'replyToMismatch']);
	});

	it('says nothing about a verified sender', () => {
		expect(
			deriveSenderRisk({
				auth: { fromDomain: 'acme.com', dmarcResult: 'pass', spfResult: 'pass' },
			})
		).toEqual([]);
	});

	it('says nothing about an unauthenticated sender — unknown is not an accusation', () => {
		expect(deriveSenderRisk({ auth: { fromDomain: 'acme.com', spfResult: 'none' } })).toEqual([]);
	});

	it('says nothing about a legacy row with no verdicts at all', () => {
		expect(deriveSenderRisk({ auth: { fromDomain: 'acme.com' } })).toEqual([]);
	});

	it('says nothing about a message a trusted forwarder’s ARC chain rescued', () => {
		expect(
			deriveSenderRisk({
				auth: {
					fromDomain: 'author.example',
					dmarcResult: 'fail',
					dmarcOverride: 'arc',
					arcSealer: 'lists.example',
				},
			})
		).toEqual([]);
	});
});

describe('deriveSenderRowMarker', () => {
	it('renders the strongest reason only — one row never grows two chips', () => {
		const marker = deriveSenderRowMarker({
			auth: { fromDomain: 'acme.com', dmarcResult: 'fail' },
			heuristics: { lookalikeOfContactDomain: 'acme-corp.com' },
		});
		expect(marker?.reason).toBe('failed');
		expect(t(marker!.label)).toBe('Failed sender check');
	});

	it('marks a look-alike domain even when the sender itself is verified', () => {
		const marker = deriveSenderRowMarker({
			auth: {
				fromDomain: 'brightpath-finance.co',
				dmarcResult: 'pass',
				spfResult: 'pass',
				envelopeFromDomain: 'brightpath-finance.co',
			},
			heuristics: { lookalikeOfContactDomain: 'brightpath.com' },
		});
		expect(marker?.reason).toBe('lookalike');
		expect(t(marker!.label)).toBe('Look-alike sender');
		expect(render(marker!.title)).toBe(
			"This sender's domain looks like brightpath.com, but is not it."
		);
	});

	it('does NOT mark a row for a Reply-To redirect alone (that is the reply guard’s job)', () => {
		expect(
			deriveSenderRowMarker({
				auth: {
					fromDomain: 'acme.com',
					dmarcResult: 'pass',
					spfResult: 'pass',
					envelopeFromDomain: 'acme.com',
				},
				heuristics: { isReplyToMismatch: true },
			})
		).toBeNull();
	});

	it('is null when nothing dangerous fired', () => {
		expect(
			deriveSenderRowMarker({ auth: { fromDomain: 'acme.com', spfResult: 'none' } })
		).toBeNull();
	});
});

describe('deriveReplyRisk', () => {
	it('fires on a Reply-To redirect the row marker deliberately ignores', () => {
		const risk = deriveReplyRisk({
			auth: {
				fromDomain: 'acme.com',
				dmarcResult: 'pass',
				spfResult: 'pass',
				envelopeFromDomain: 'acme.com',
			},
			heuristics: { isReplyToMismatch: true },
		});
		expect(risk?.reasons).toEqual(['replyToMismatch']);
		// Deliberately NOT the badge's "replies would go" line: this client
		// addresses a reply to the From address, so the honest claim is about what
		// the message asked for.
		expect(risk!.lines.map(render)).toEqual([
			'This message asks for replies at a different domain than the one it says it is from.',
		]);
	});

	it('is null for an ordinary sender, so the interstitial never renders', () => {
		expect(
			deriveReplyRisk({
				auth: {
					fromDomain: 'acme.com',
					dmarcResult: 'pass',
					spfResult: 'pass',
					envelopeFromDomain: 'acme.com',
				},
			})
		).toBeNull();
	});
});

describe('senderRiskInputOf', () => {
	it('reads the From domain out of a full header value', () => {
		const input = senderRiskInputOf({
			fromAddress: 'Brightpath Finance <billing@Brightpath-Finance.CO>',
			dmarcResult: 'fail',
			senderHeuristics: { isFirstTimeSender: true },
		});
		expect(input.auth.fromDomain).toBe('brightpath-finance.co');
		expect(input.heuristics).toEqual({ isFirstTimeSender: true });
	});

	it('leaves the domain empty when the header carries no address', () => {
		expect(senderAuthInputOf({ fromAddress: 'undisclosed-recipients' }).fromDomain).toBe('');
	});
});
