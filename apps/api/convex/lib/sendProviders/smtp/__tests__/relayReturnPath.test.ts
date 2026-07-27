import { describe, expect, it } from 'vitest';
import { VERP_KEY_MIN_BYTES, parseVerpAddress } from '@owlat/shared/verp';
import { resolveRelayEnvelopeSender } from '../index';

/**
 * G-08 (1) — a relay send carries OUR VERP envelope sender where the transport
 * is proven to support it, and that address round-trips through the SHIPPED
 * VERP decoder so a bounce the relay generates is attributable to the right
 * send. One scheme, `@owlat/shared/verp`, used by both arms.
 */

// At least VERP_KEY_MIN_BYTES: a shorter key is refused outright (see below).
const KEY = 'test-verp-key-'.padEnd(32, 'x');
const DOMAIN = 'bounces.example.com';
const NOW = Date.UTC(2026, 6, 27, 12, 0, 0);

function stamp(overrides: Partial<Parameters<typeof resolveRelayEnvelopeSender>[0]> = {}) {
	return resolveRelayEnvelopeSender({
		composedEnvelopeFrom: 'news@example.com',
		messageId: 'msg-abc-123',
		returnPathHost: DOMAIN,
		verpKey: KEY,
		now: NOW,
		...overrides,
	});
}

describe('resolveRelayEnvelopeSender — VERP on the relay arm', () => {
	it('stamps a signed VERP envelope sender at our bounce domain', () => {
		const { envelopeFrom, isVerp } = stamp();
		expect(isVerp).toBe(true);
		expect(envelopeFrom.startsWith('bounce+')).toBe(true);
		expect(envelopeFrom.endsWith(`@${DOMAIN}`)).toBe(true);
	});

	it('round-trips through the shipped decoder to the originating message id', () => {
		const { envelopeFrom } = stamp();
		expect(parseVerpAddress(envelopeFrom, KEY, NOW)).toBe('msg-abc-123');
	});

	it('still verifies inside the multi-day DSN acceptance window', () => {
		const { envelopeFrom } = stamp();
		const sixDaysLater = NOW + 6 * 24 * 60 * 60 * 1000;
		expect(parseVerpAddress(envelopeFrom, KEY, sixDaysLater)).toBe('msg-abc-123');
	});

	it('does not verify under a different key (a forged relay bounce)', () => {
		const { envelopeFrom } = stamp();
		expect(parseVerpAddress(envelopeFrom, 'other-key', NOW)).toBeNull();
	});

	it('keeps the composed envelope sender when no host was authorised', () => {
		const { envelopeFrom, isVerp } = stamp({ returnPathHost: undefined });
		expect(isVerp).toBe(false);
		expect(envelopeFrom).toBe('news@example.com');
	});

	it('never stamps an UNSIGNED token when no key is configured', () => {
		const { envelopeFrom, isVerp } = stamp({ verpKey: undefined });
		expect(isVerp).toBe(false);
		expect(envelopeFrom).toBe('news@example.com');
	});

	it('refuses a key SHORTER than the floor the MTA enforces at startup', () => {
		// A short/typo'd Convex copy would mint tokens the MTA never verifies, so
		// every relayed bounce would arrive unattributable and this arm would look
		// bounce-free — the exact measurement bias G-08 exists to remove.
		const { envelopeFrom, isVerp } = stamp({ verpKey: 'x'.repeat(VERP_KEY_MIN_BYTES - 1) });
		expect(isVerp).toBe(false);
		expect(envelopeFrom).toBe('news@example.com');
		expect(stamp({ verpKey: 'x'.repeat(VERP_KEY_MIN_BYTES) }).isVerp).toBe(true);
	});

	it('degenerates safely on an empty message id rather than signing nothing', () => {
		const { envelopeFrom, isVerp } = stamp({ messageId: '' });
		expect(isVerp).toBe(false);
		expect(envelopeFrom).toBe('news@example.com');
	});

	it('refuses a degenerate clock rather than minting an unverifiable token', () => {
		// The time window is part of the signed material, so a non-finite `now`
		// mints a token that can never verify at the MTA — which reads downstream
		// as "this arm produced no bounces", the bias G-08 removes. Fall back to
		// the composed sender instead, exactly as for a missing key.
		for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const { envelopeFrom, isVerp } = stamp({ now });
			expect(isVerp).toBe(false);
			expect(envelopeFrom).toBe('news@example.com');
		}
	});

	it('gives two sends distinct, individually attributable return paths', () => {
		const a = stamp({ messageId: 'send-a' }).envelopeFrom;
		const b = stamp({ messageId: 'send-b' }).envelopeFrom;
		expect(a).not.toBe(b);
		expect(parseVerpAddress(a, KEY, NOW)).toBe('send-a');
		expect(parseVerpAddress(b, KEY, NOW)).toBe('send-b');
	});
});
