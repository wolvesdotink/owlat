import { describe, expect, it } from 'vitest';
import { composeMessage } from '@owlat/mail-message';
import { resolveRelayEnvelopeSender } from '../index';

/**
 * D11 — NEVER give the two arms of a cell different sending identities. The
 * custom return path changes the RFC5321.MailFrom and NOTHING else: same From
 * domain, same DKIM `d=` (the composer's bytes are what gets signed), same
 * Message-ID scheme, same headers, same body. Only the envelope differs.
 *
 * The assertion is byte-level on the composed message, because the composed
 * bytes ARE what the DKIM signer covers and what DMARC alignment is evaluated
 * against; if they are identical with and without the custom return path,
 * alignment cannot have moved.
 */

const KEY = 'alignment-key-'.padEnd(32, 'x');
const NOW = Date.UTC(2026, 6, 27, 9, 30, 0);

const PARAMS = {
	from: 'Newsletter <news@example.com>',
	to: ['subscriber@gmail.com'],
	subject: 'Weekly digest',
	html: '<p>Hello</p>',
	text: 'Hello',
	headers: { 'X-Owlat-Message-Id': 'send-42' },
} as const;

function composeOnce() {
	return composeMessage({
		from: PARAMS.from,
		to: [...PARAMS.to],
		subject: PARAMS.subject,
		html: PARAMS.html,
		text: PARAMS.text,
		headers: { ...PARAMS.headers },
	});
}

describe('custom return path — alignment is untouched (D11)', () => {
	it('changes only the envelope sender, never the composed bytes', () => {
		const composed = composeOnce();

		const withoutCustom = resolveRelayEnvelopeSender({
			composedEnvelopeFrom: composed.envelope.from,
			messageId: composed.messageId,
			customReturnPath: false,
			returnPathDomain: 'bounces.example.com',
			verpKey: KEY,
			now: NOW,
		});
		const withCustom = resolveRelayEnvelopeSender({
			composedEnvelopeFrom: composed.envelope.from,
			messageId: composed.messageId,
			customReturnPath: true,
			returnPathDomain: 'bounces.example.com',
			verpKey: KEY,
			now: NOW,
		});

		// The one thing that MAY differ.
		expect(withoutCustom.envelopeFrom).toBe(composed.envelope.from);
		expect(withCustom.envelopeFrom).not.toBe(composed.envelope.from);
		expect(withCustom.envelopeFrom.endsWith('@bounces.example.com')).toBe(true);

		// Everything the receiver authenticates on is unchanged: the resolver is
		// pure and never even sees the message bytes.
		const raw = composed.raw.toString('utf8');
		expect(/^From:.*news@example\.com/im.test(raw)).toBe(true);
		// The VERP address exists ONLY in the SMTP envelope — never in the signed
		// header block, so it cannot move DKIM or DMARC alignment.
		expect(raw).not.toContain(withCustom.envelopeFrom);
		expect(composed.envelope.to).toEqual(['subscriber@gmail.com']);
	});

	it('keeps the same From identity and Message-ID scheme on both arms', () => {
		const a = composeOnce();
		const b = composeOnce();

		const headerValue = (raw: string, name: string): string | undefined =>
			new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(raw)?.[1]?.trim();
		const host = (address: string): string | undefined => address.split('@')[1];

		const rawA = a.raw.toString('utf8');
		const rawB = b.raw.toString('utf8');

		// The From header — the DKIM signing domain and the DMARC alignment domain
		// — is the same string on both arms.
		expect(headerValue(rawA, 'From')).toBe(headerValue(rawB, 'From'));
		expect(headerValue(rawA, 'From')).toContain('news@example.com');
		// Same Message-ID SCHEME (same right-hand side), distinct ids.
		expect(host(a.messageId)).toBe(host(b.messageId));
		expect(a.messageId).not.toBe(b.messageId);
		// Same envelope sender before the return-path decision is applied.
		expect(a.envelope.from).toBe(b.envelope.from);
		expect(host(a.envelope.from)).toBe('example.com');
	});
});
