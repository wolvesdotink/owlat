/**
 * Sender-authentication derivation (Sealed Mail A3) — the honesty audit.
 *
 * Six fixtures pin every reachable state to the exact verdict shape that
 * produces it, and the "legacy row" case proves absence NEVER renders as
 * verified (fail-closed). The verbatim misaligned string is asserted here.
 */
import { describe, it, expect } from 'vitest';
import { deriveSenderAuth, type SenderAuthInput } from '../senderAuth';

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
});
