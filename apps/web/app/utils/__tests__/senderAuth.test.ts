/**
 * Sender-authentication derivation (Sealed Mail A3) — the honesty audit.
 *
 * Six fixtures pin every reachable state to the exact verdict shape that
 * produces it, and the "legacy row" case proves absence NEVER renders as
 * verified (fail-closed). The verbatim misaligned string is asserted here.
 */
import { describe, it, expect } from 'vitest';
import {
	deriveOstrChip,
	deriveSenderAuth,
	deriveSenderHeuristicLines,
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
 * The OSTR registry tier chip — the same fail-closed rule as the badge above:
 * a tier only ever renders what the registry actually said, and "no evidence"
 * (`unknown`, or an absent field) is silence rather than a reassuring chip.
 */
describe('deriveOstrChip', () => {
	it('maps each speaking tier to its tone and its catalog keys', () => {
		expect(deriveOstrChip('establishing')).toEqual({
			labelKey: 'shared.ostr.tier.establishing.label',
			detailKey: 'shared.ostr.tier.establishing.detail',
			tone: 'neutral',
		});
		expect(deriveOstrChip('trusted')?.tone).toBe('ok');
		expect(deriveOstrChip('warned')?.tone).toBe('warn');
		expect(deriveOstrChip('flagged')?.tone).toBe('danger');
	});

	it('separates a short clean history from a sustained one', () => {
		// The two differ on strength of evidence, so they must not share a tone:
		// `trusted` is the only tier that earns the reassuring one.
		expect(deriveOstrChip('establishing')?.tone).not.toBe(deriveOstrChip('trusted')?.tone);
	});

	it('renders real copy for every tier, never a bare key', () => {
		for (const tier of ['establishing', 'trusted', 'warned', 'flagged']) {
			const chip = deriveOstrChip(tier)!;
			expect(t(chip.labelKey)).not.toBe(chip.labelKey);
			expect(t(chip.detailKey)).not.toBe(chip.detailKey);
		}
	});

	it('says nothing when the registry knows nothing', () => {
		expect(deriveOstrChip(undefined)).toBeNull();
		expect(deriveOstrChip('unknown')).toBeNull();
		expect(deriveOstrChip('')).toBeNull();
	});

	it('says nothing for a tier this build does not know', () => {
		// A newer MTA could persist a tier a shipped client has no copy for; a
		// chip it cannot explain is worse than no chip.
		expect(deriveOstrChip('quarantined')).toBeNull();
		// Including the inherited names an object-literal lookup table would
		// answer to: those would mint a chip whose label key has no copy, and the
		// reader would be shown the raw key path.
		expect(deriveOstrChip('constructor')).toBeNull();
		expect(deriveOstrChip('__proto__')).toBeNull();
		expect(deriveOstrChip('toString')).toBeNull();
		expect(deriveOstrChip('hasOwnProperty')).toBeNull();
	});

	it('accepts the tier as persisted, whatever its casing or padding', () => {
		expect(deriveOstrChip('  Trusted ')?.tone).toBe('ok');
	});
});
