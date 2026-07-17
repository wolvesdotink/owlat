/**
 * SMTPUTF8 / EAI (RFC 6531/6532) — the compose half of piece X3.
 *
 * Named test gate (a): an internationalized message (a non-ASCII local-part and
 * a non-ASCII display name) composed through `composeMessage` must
 *   1. carry those header values as NATIVE UTF-8 — not RFC 2047 encoded-words —
 *      because there is no encoded-word form for an addr-spec local-part;
 *   2. round-trip byte-exact through mailparser (the independent oracle, I1): the
 *      recovered `{ name, address }` for From/To equals the input, and the decoded
 *      Subject equals the input; and
 *   3. still DKIM-verify `pass` under mailauth (I1/I6) once signed — UTF-8 header
 *      bytes canonicalize and sign like any other octets.
 *
 * The auto-detection contract is pinned too: a non-ASCII LOCAL-PART flips the
 * message to EAI without an explicit flag (it MUST — it cannot be encoded), while
 * a message whose only non-ASCII text is a display name / subject stays on the
 * pre-X3 encoded-word path (so the R2 golden corpus is unchanged — gate (c)).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { dkimVerify } from 'mailauth';

import { composeMessage, type ComposeMessageInput } from '../src/compose/compose';
import { signMessage, type DkimSigningKey } from '../src/compose/dkim';

const DOMAIN = 'example.com';
const SELECTOR = 's2026';
const SIGN_TIME_MS = 1_760_000_000_000;

let signingKey: DkimSigningKey;
let resolver: (name: string, rrtype: string) => Promise<string[][]>;

beforeAll(() => {
	const { publicKey, privateKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});
	signingKey = { domainName: DOMAIN, keySelector: SELECTOR, privateKey };
	const p = publicKey
		.replace('-----BEGIN PUBLIC KEY-----', '')
		.replace('-----END PUBLIC KEY-----', '')
		.replace(/\s/g, '');
	const record = `v=DKIM1; k=rsa; p=${p}`;
	const expectedName = `${SELECTOR}._domainkey.${DOMAIN}`;
	resolver = async (name: string, rrtype: string): Promise<string[][]> =>
		rrtype === 'TXT' && name === expectedName ? [[record]] : [];
});

/** The header block (everything before the empty line) as a UTF-8 string. */
function headerBlock(raw: Buffer): string {
	const text = raw.toString('utf-8');
	const end = text.indexOf('\r\n\r\n');
	return end === -1 ? text : text.slice(0, end);
}

/** The value of a single unfolded header line by name. */
function headerValue(raw: Buffer, name: string): string {
	const block = headerBlock(raw).replace(/\r\n[ \t]+/g, ' ');
	const re = new RegExp(`^${name}: (.*)$`, 'mi');
	return re.exec(block)?.[1]?.trim() ?? '';
}

describe('EAI compose — native UTF-8 headers, mailparser round-trip, mailauth verify', () => {
	// A non-ASCII local-part (`用户`) AND non-ASCII display names, ASCII domains.
	const input: ComposeMessageInput = {
		from: '发件人 <用户@example.com>',
		to: ['收件人 <收件@example.com>'],
		subject: 'Grüße 世界 — EAI subject',
		text: 'Body stays 7-bit safe.\n',
		date: new Date('2026-06-21T12:00:00Z'),
		boundarySeed: 'eai-seed',
		messageId: '<eai@example.com>',
	};

	it('auto-enables EAI on a non-ASCII local-part and emits native UTF-8 (no encoded-words) in address + subject headers', () => {
		const { raw } = composeMessage(input);
		const from = headerValue(raw, 'From');
		const to = headerValue(raw, 'To');
		const subject = headerValue(raw, 'Subject');

		// Native UTF-8, not RFC 2047 encoded-words.
		expect(from).not.toContain('=?');
		expect(to).not.toContain('=?');
		expect(subject).not.toContain('=?');
		expect(from).toBe('发件人 <用户@example.com>');
		expect(to).toBe('收件人 <收件@example.com>');
		expect(subject).toBe('Grüße 世界 — EAI subject');
	});

	it('round-trips byte-exact through mailparser: recovered addresses and subject equal the input', async () => {
		const { raw } = composeMessage(input);
		const parsed = await simpleParser(raw);

		const from = parsed.from?.value[0];
		expect(from?.name).toBe('发件人');
		expect(from?.address).toBe('用户@example.com');

		const to = Array.isArray(parsed.to) ? parsed.to[0]?.value[0] : parsed.to?.value[0];
		expect(to?.name).toBe('收件人');
		expect(to?.address).toBe('收件@example.com');

		expect(parsed.subject).toBe('Grüße 世界 — EAI subject');
	});

	it('the signed EAI message verifies DKIM pass under mailauth', async () => {
		const composed = composeMessage(input).raw;
		const signed = signMessage(composed, signingKey, SIGN_TIME_MS);
		// Feed the signed Buffer straight to mailauth: a `.toString('binary')` (latin1)
		// projection would be re-encoded as UTF-8 by mailauth's `Buffer.from(input)`,
		// mangling every 0x80–0xFF octet of a non-ASCII header so the verified bytes
		// would differ from the signed bytes. Buffers are consumed byte-faithfully.
		const result = (await dkimVerify(signed, { resolver })) as unknown as {
			results: Array<{ status: { result: string }; signingDomain?: string }>;
		};
		expect(result.results.length).toBeGreaterThan(0);
		expect(result.results[0]?.status.result).toBe('pass');
		expect(result.results[0]?.signingDomain).toBe(DOMAIN);
	});

	it('an explicit `eai: true` keeps a special-character UTF-8 display name as a quoted-string that re-parses to the same name', async () => {
		const { raw } = composeMessage({
			from: 'Müller, Jörg <jm@example.com>',
			to: ['a@example.com'],
			subject: 's',
			text: 'x',
			eai: true,
			date: input.date,
			boundarySeed: 'eai-quote',
			messageId: '<q@example.com>',
		});
		const from = headerValue(raw, 'From');
		expect(from).toContain('"Müller, Jörg"');
		const parsed = await simpleParser(raw);
		expect(parsed.from?.value[0]?.name).toBe('Müller, Jörg');
		expect(parsed.from?.value[0]?.address).toBe('jm@example.com');
	});
});

describe('non-EAI is preserved (R2 golden path unchanged)', () => {
	it('a non-ASCII display name with an ASCII local-part stays RFC 2047 encoded — no native UTF-8', () => {
		const { raw } = composeMessage({
			from: 'Grüße <ascii@example.com>',
			to: ['plain@example.com'],
			subject: 'Grüße',
			text: 'x',
			date: new Date('2026-06-21T12:00:00Z'),
			boundarySeed: 'ascii-seed',
			messageId: '<ascii@example.com>',
		});
		const from = headerValue(raw, 'From');
		const subject = headerValue(raw, 'Subject');
		// Encoded-word form retained — the addr-spec is pure ASCII so EAI never trips.
		expect(from).toContain('=?UTF-8?B?');
		expect(subject).toContain('=?UTF-8?B?');
		expect(from).not.toContain('Grüße <');
	});

	it('a fully ASCII message is unaffected by the EAI plumbing', async () => {
		const { raw } = composeMessage({
			from: 'Alice <alice@example.com>',
			to: ['bob@example.com'],
			subject: 'Plain subject',
			text: 'x',
			date: new Date('2026-06-21T12:00:00Z'),
			boundarySeed: 'plain-seed',
			messageId: '<plain@example.com>',
		});
		expect(headerValue(raw, 'From')).toBe('Alice <alice@example.com>');
		const parsed = await simpleParser(raw);
		expect(parsed.subject).toBe('Plain subject');
	});
});

describe('domains are IDN-normalized at composition (W6) — no SMTPUTF8 for a domain-only IDN', () => {
	it('punycodes a U-label domain in header + envelope and keeps the message ASCII (no native UTF-8)', () => {
		// ASCII local-part, non-ASCII (U-label) domain: there IS an ASCII downgrade
		// (punycode) for the domain, so the composer normalizes it to A-labels and the
		// message never needs SMTPUTF8 — the EAI/native-UTF-8 path is NOT tripped.
		const { raw, envelope } = composeMessage({
			from: 'user@例え.test',
			to: ['dest@例え.テスト'],
			subject: 's',
			text: 'x',
			date: new Date('2026-06-21T12:00:00Z'),
			boundarySeed: 'idn-seed',
			messageId: '<idn@example.com>',
		});
		const from = headerValue(raw, 'From');
		const to = headerValue(raw, 'To');
		expect(from).toBe('user@xn--r8jz45g.test');
		expect(to).toBe('dest@xn--r8jz45g.xn--zckzah');
		// The whole rendered header block is pure ASCII — no native UTF-8 leaked.
		// eslint-disable-next-line no-control-regex
		expect(/[^\x00-\x7F]/.test(headerBlock(raw))).toBe(false);
		// The envelope handed downstream (MAIL FROM / RCPT TO, MX resolution) is A-label.
		expect(envelope.from).toBe('user@xn--r8jz45g.test');
		expect(envelope.to).toEqual(['dest@xn--r8jz45g.xn--zckzah']);
	});

	it('preserves the display name while punycoding the domain of a name-addr', () => {
		const { raw } = composeMessage({
			from: 'Soren <soeren@exämple.test>',
			to: ['a@example.com'],
			subject: 's',
			text: 'x',
			date: new Date('2026-06-21T12:00:00Z'),
			boundarySeed: 'idn-name-seed',
			messageId: '<idn2@example.com>',
		});
		// Domain punycoded; the ASCII local-part and display name are untouched, so the
		// addr-spec never trips EAI.
		expect(headerValue(raw, 'From')).toBe('Soren <soeren@xn--exmple-cua.test>');
	});
});
