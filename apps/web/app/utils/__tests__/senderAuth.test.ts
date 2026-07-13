/**
 * Sender-authentication derivation (Sealed Mail A3) — the honesty audit.
 *
 * Six fixtures pin every reachable state to the exact verdict shape that
 * produces it, and the "legacy row" case proves absence NEVER renders as
 * verified (fail-closed). The verbatim misaligned string is asserted here.
 */
import { describe, it, expect } from 'vitest';
import { deriveSenderAuth, deriveSenderHeuristicLines, type SenderAuthInput } from '../senderAuth';

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
		expect(result?.detail).toBe(
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
		expect(result?.summary).toBe('Verified via forwarder');
		expect(result?.detail).toBe(
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
		expect(result?.detail).toBe(
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
			})
		).toEqual([
			"This sender's domain looks like paypal.com, but is not it.",
			"The sender's domain uses look-alike characters that imitate another domain.",
			'Replies would go to a different domain than this message claims to be from.',
			"This is the first message you've received from this address.",
		]);
	});

	it('names the resembled domain in the look-alike line', () => {
		expect(deriveSenderHeuristicLines({ lookalikeOfContactDomain: 'stripe.com' })).toEqual([
			"This sender's domain looks like stripe.com, but is not it.",
		]);
	});

	it('ignores a blank look-alike domain', () => {
		expect(deriveSenderHeuristicLines({ lookalikeOfContactDomain: '  ' })).toEqual([]);
	});

	it('emits only the first-time line when that is all that fired', () => {
		expect(deriveSenderHeuristicLines({ isFirstTimeSender: true })).toEqual([
			"This is the first message you've received from this address.",
		]);
	});
});
