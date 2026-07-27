import { describe, expect, it } from 'vitest';
import { parseVerpAddressWithKey } from '@owlat/shared/verp';
import { resolveRelayEnvelopeSender } from '../index';

/**
 * G-08 (1) — a relay send carries OUR VERP envelope sender where the transport
 * is proven to support it, and that address round-trips through the SHIPPED
 * VERP decoder so a bounce the relay generates is attributable to the right
 * send. One scheme, `@owlat/shared/verp`, used by both arms.
 */

const KEY = 'test-verp-key';
const DOMAIN = 'bounces.example.com';
const NOW = Date.UTC(2026, 6, 27, 12, 0, 0);

function stamp(overrides: Partial<Parameters<typeof resolveRelayEnvelopeSender>[0]> = {}) {
	return resolveRelayEnvelopeSender({
		composedEnvelopeFrom: 'news@example.com',
		messageId: 'msg-abc-123',
		customReturnPath: true,
		returnPathDomain: DOMAIN,
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
		expect(parseVerpAddressWithKey(envelopeFrom, KEY, NOW)).toBe('msg-abc-123');
	});

	it('still verifies inside the multi-day DSN acceptance window', () => {
		const { envelopeFrom } = stamp();
		const sixDaysLater = NOW + 6 * 24 * 60 * 60 * 1000;
		expect(parseVerpAddressWithKey(envelopeFrom, KEY, sixDaysLater)).toBe('msg-abc-123');
	});

	it('does not verify under a different key (a forged relay bounce)', () => {
		const { envelopeFrom } = stamp();
		expect(parseVerpAddressWithKey(envelopeFrom, 'other-key', NOW)).toBeNull();
	});

	it('keeps the composed envelope sender when the capability is unproven', () => {
		const { envelopeFrom, isVerp } = stamp({ customReturnPath: false });
		expect(isVerp).toBe(false);
		expect(envelopeFrom).toBe('news@example.com');
	});

	it('never stamps an UNSIGNED token when no key is configured', () => {
		const { envelopeFrom, isVerp } = stamp({ verpKey: undefined });
		expect(isVerp).toBe(false);
		expect(envelopeFrom).toBe('news@example.com');
	});

	it('keeps the composed envelope sender when no return-path domain is set', () => {
		expect(stamp({ returnPathDomain: undefined }).envelopeFrom).toBe('news@example.com');
		expect(stamp({ returnPathDomain: '   ' }).envelopeFrom).toBe('news@example.com');
	});

	it('tolerates a trailing-dot (absolute) return-path domain', () => {
		const { envelopeFrom } = stamp({ returnPathDomain: `${DOMAIN}.` });
		expect(envelopeFrom.endsWith(`@${DOMAIN}`)).toBe(true);
	});

	it('degenerates safely on an empty message id rather than signing nothing', () => {
		const { envelopeFrom, isVerp } = stamp({ messageId: '' });
		expect(isVerp).toBe(false);
		expect(envelopeFrom).toBe('news@example.com');
	});

	it('gives two sends distinct, individually attributable return paths', () => {
		const a = stamp({ messageId: 'send-a' }).envelopeFrom;
		const b = stamp({ messageId: 'send-b' }).envelopeFrom;
		expect(a).not.toBe(b);
		expect(parseVerpAddressWithKey(a, KEY, NOW)).toBe('send-a');
		expect(parseVerpAddressWithKey(b, KEY, NOW)).toBe('send-b');
	});
});
