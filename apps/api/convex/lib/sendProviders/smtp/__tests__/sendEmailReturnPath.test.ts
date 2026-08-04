import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VERP_KEY_MIN_BYTES, parseVerpAddress } from '@owlat/shared/verp';

/**
 * The PRODUCTION WIRING of G-08 (1), at the level where D11 can actually break:
 * `smtpSendProvider.sendEmail` must put our VERP address on `envelope.from`
 * while `envelope.data` — the bytes the DKIM signer covers and DMARC alignment
 * is evaluated against — stays BYTE-IDENTICAL between a VERP run and a
 * non-VERP run of the same message.
 *
 * The relay socket is stubbed; nothing here touches a network.
 */

const sendMessage = vi.hoisted(() => vi.fn());

vi.mock('@owlat/smtp-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('@owlat/smtp-client')>()),
	sendMessage,
}));

import { _resetSmtpConfigCacheForTests, smtpSendProvider } from '../index';
import type { SendTransportRecord } from '../../transports';

const KEY = 'relay-verp-key-'.padEnd(VERP_KEY_MIN_BYTES, 'x');
const NOW = Date.UTC(2026, 6, 27, 12, 0, 0);

const TRANSPORT = {
	id: 'smtp',
	kind: 'smtp',
	instanceKey: null,
	label: 'SMTP relay',
} as unknown as SendTransportRecord;

const PARAMS = {
	to: 'subscriber@gmail.com',
	from: 'Newsletter <news@example.com>',
	subject: 'Weekly digest',
	html: '<p>Hello</p>',
	text: 'Hello',
	headers: { 'X-Owlat-Message-Id': 'send-42' },
};

function lastEnvelope(): { from: string; to: string[]; data: Buffer } {
	// Not `.calls.at(-1)`: convex/tsconfig.json's lib is ES2021, where
	// Array.prototype.at does not exist.
	const calls = sendMessage.mock.calls;
	const call = calls[calls.length - 1]?.[0] as
		| { envelope: { from: string; to: string[]; data: Buffer } }
		| undefined;
	if (!call) throw new Error('sendMessage was never called');
	return call.envelope;
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
	sendMessage.mockReset();
	sendMessage.mockResolvedValue(undefined);
	_resetSmtpConfigCacheForTests();
	vi.stubEnv('SMTP_RELAY_HOST', 'relay.example.net');
	vi.stubEnv('SMTP_RELAY_USERNAME', 'user');
	vi.stubEnv('SMTP_RELAY_PASSWORD', 'pass');
	vi.stubEnv('EHLO_HOSTNAME', 'mail.example.com');
	vi.stubEnv('MTA_RETURN_PATH_DOMAIN', 'bounces.example.com');
	vi.stubEnv('MTA_BOUNCE_VERP_KEY', KEY);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	_resetSmtpConfigCacheForTests();
});

describe('smtpSendProvider.sendEmail — the custom return path on the wire', () => {
	it('stamps the VERP envelope sender at the host the routing pass authorised', async () => {
		const attempt = await smtpSendProvider.sendEmail(TRANSPORT, PARAMS, {
			returnPathHost: 'bounces.example.com',
		});
		// Narrows EmailSendAttempt to its success arm — `id` only exists there, and
		// the assertion below is this file's strongest claim, so it must not rest on
		// an unnarrowed read.
		if (!attempt.success) throw new Error(attempt.errorMessage);
		const envelope = lastEnvelope();
		expect(envelope.from).not.toBe('news@example.com');
		expect(envelope.from.endsWith('@bounces.example.com')).toBe(true);
		// The token attributes the eventual DSN to the id we stored for the send.
		expect(parseVerpAddress(envelope.from, KEY, NOW)).toBe(attempt.id);
	});

	it('leaves the composed envelope sender alone when no host was authorised', async () => {
		await smtpSendProvider.sendEmail(TRANSPORT, PARAMS, {});
		expect(lastEnvelope().from).toBe('news@example.com');
		// …and with no extras at all — the exact shipped behaviour.
		await smtpSendProvider.sendEmail(TRANSPORT, PARAMS);
		expect(lastEnvelope().from).toBe('news@example.com');
	});

	it('D11: envelope.data is BYTE-IDENTICAL with and without the VERP stamp', async () => {
		// Same Message-ID on both runs, so any byte difference is caused by the
		// return path and nothing else. (A real pair of sends differs only in the
		// Message-ID and Date the composer generates.)
		const withVerp = await runAndCapture({ returnPathHost: 'bounces.example.com' });
		const withoutVerp = await runAndCapture({});

		expect(withVerp.data.equals(withoutVerp.data)).toBe(true);
		expect(withVerp.to).toEqual(withoutVerp.to);
		// The ONE thing that may differ.
		expect(withVerp.from).not.toBe(withoutVerp.from);
		// And the VERP address appears ONLY in the envelope, never in the signed
		// header block — so it cannot move DKIM `d=` or DMARC alignment.
		expect(withVerp.data.toString('utf8')).not.toContain(withVerp.from);
		expect(withVerp.data.toString('utf8')).toMatch(/^From:.*news@example\.com/im);
	});

	it('does not stamp when the deployment configured no signing key', async () => {
		vi.stubEnv('MTA_BOUNCE_VERP_KEY', '');
		await smtpSendProvider.sendEmail(TRANSPORT, PARAMS, { returnPathHost: 'bounces.example.com' });
		expect(lastEnvelope().from).toBe('news@example.com');
	});

	it('does not stamp under a key SHORTER than the MTA would accept', async () => {
		vi.stubEnv('MTA_BOUNCE_VERP_KEY', 'x'.repeat(VERP_KEY_MIN_BYTES - 1));
		await smtpSendProvider.sendEmail(TRANSPORT, PARAMS, { returnPathHost: 'bounces.example.com' });
		expect(lastEnvelope().from).toBe('news@example.com');
	});
});

/**
 * Runs one send and returns its envelope with the three values the composer
 * generates FRESH on every call — Message-ID, Date and the crypto-random MIME
 * boundary — neutralised. Those differ between any two sends, custom return
 * path or not; everything else must not, which is what D11 asserts.
 */
async function runAndCapture(extras: {
	returnPathHost?: string;
}): Promise<{ from: string; to: string[]; data: Buffer }> {
	await smtpSendProvider.sendEmail(TRANSPORT, PARAMS, extras);
	const envelope = lastEnvelope();
	const normalized = envelope.data
		.toString('utf8')
		.replace(/^Message-ID:.*$/im, 'Message-ID: <pinned>')
		.replace(/^Date:.*$/im, 'Date: pinned')
		.replace(/--_owlat_[0-9a-f]+/g, '--_owlat_pinned');
	return { from: envelope.from, to: envelope.to, data: Buffer.from(normalized, 'utf8') };
}
