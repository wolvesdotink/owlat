/**
 * Inbound DKIM verification — RFC 6376 / RFC 8601.
 *
 * These tests build their own fixtures so they're hermetic (no real DNS):
 *   - a fresh RSA keypair is generated per run,
 *   - a message is signed with `mailauth`'s `dkimSign`,
 *   - the matching public key is published through a mocked TXT `resolver`
 *     keyed on `<selector>._domainkey.<domain>`.
 *
 * Fixture A: validly-signed message + matching public key  -> { result: 'pass', domain }
 * Fixture B: one body byte mutated after signing            -> { result: 'fail' }
 * Fixture C: signature present + TXT lookup ENOTFOUND       -> { result: 'permerror' }
 *
 * Integration: the bounce `onData` handler threads the verify result into the
 * personal-mailbox `inbound.mailbox.received` event's `mailboxPayload.dkimResult`.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { dkimSign } from 'mailauth/lib/dkim/sign.js';
import { verifyDkim, type DkimDnsResolver } from '../inboundDkim.js';
import type { ParsedMessage } from '@owlat/mail-message';

const DOMAIN = 'example.com';
const SELECTOR = 'selector';

let privateKey: string;
let txtRecord: string;
let signedMessage: Buffer;

/** Build the DKIM `v=DKIM1; k=rsa; p=<base64 SPKI>` TXT record body. */
function buildTxtRecord(publicKeyPem: string): string {
	const der = publicKeyPem
		.replace(/-----BEGIN PUBLIC KEY-----/, '')
		.replace(/-----END PUBLIC KEY-----/, '')
		.replace(/\s+/g, '');
	return `v=DKIM1; k=rsa; p=${der}`;
}

const RAW_MESSAGE = [
	'From: Alice <alice@example.com>',
	'To: Bob <bob@example.org>',
	'Subject: DKIM fixture',
	'Date: Tue, 17 Jun 2026 12:00:00 +0000',
	'Message-ID: <fixture-1@example.com>',
	'MIME-Version: 1.0',
	'Content-Type: text/plain; charset=utf-8',
	'',
	'Hello from a DKIM-signed message body.',
	'',
].join('\r\n');

beforeAll(async () => {
	const keyPair = generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});
	privateKey = keyPair.privateKey;
	txtRecord = buildTxtRecord(keyPair.publicKey);

	// mailauth's signer reads the key set off `signatureData` (the flat
	// top-level fields in its type defs are not honored at runtime).
	const signResult = await dkimSign(Buffer.from(RAW_MESSAGE), {
		canonicalization: 'relaxed/relaxed',
		algorithm: 'rsa-sha256',
		signatureData: [
			{
				signingDomain: DOMAIN,
				selector: SELECTOR,
				privateKey,
			},
		],
	});
	expect(signResult.errors).toHaveLength(0);
	expect(signResult.signatures).toContain('DKIM-Signature');

	// Prepend the DKIM-Signature header to the original message.
	signedMessage = Buffer.from(signResult.signatures + RAW_MESSAGE);
});

/** A resolver that serves our generated key for the expected name only. */
function passingResolver(): DkimDnsResolver {
	return vi.fn(async (name: string, rrtype: string) => {
		if (rrtype === 'TXT' && name === `${SELECTOR}._domainkey.${DOMAIN}`) {
			return [[txtRecord]];
		}
		const err = new Error(`ENOTFOUND ${name}`) as Error & { code: string };
		err.code = 'ENOTFOUND';
		throw err;
	});
}

/** A resolver where the selector record does not exist (NXDOMAIN). */
function notFoundResolver(): DkimDnsResolver {
	return vi.fn(async (name: string) => {
		const err = new Error(`ENOTFOUND ${name}`) as Error & { code: string };
		err.code = 'ENOTFOUND';
		throw err;
	});
}

describe('verifyDkim (RFC 6376 / RFC 8601)', () => {
	it('Fixture A: valid signature + published key -> pass', async () => {
		const outcome = await verifyDkim(signedMessage, { resolver: passingResolver() });
		expect(outcome.result).toBe('pass');
		expect(outcome.domain).toBe(DOMAIN);
	});

	it('Fixture B: one body byte mutated after signing -> fail', async () => {
		// Flip the final body character so the body hash no longer matches.
		const mutated = Buffer.from(signedMessage);
		// Find the last alphabetic byte in the body and change it.
		for (let i = mutated.length - 1; i >= 0; i--) {
			const c = mutated[i]!;
			if (c >= 0x61 && c <= 0x7a) {
				mutated[i] = c === 0x7a ? 0x61 : c + 1;
				break;
			}
		}
		const outcome = await verifyDkim(mutated, { resolver: passingResolver() });
		expect(outcome.result).toBe('fail');
	});

	it('Fixture C: signature present + TXT ENOTFOUND -> permerror', async () => {
		const outcome = await verifyDkim(signedMessage, { resolver: notFoundResolver() });
		expect(outcome.result).toBe('permerror');
	});

	it('no DKIM-Signature header -> none', async () => {
		const outcome = await verifyDkim(Buffer.from(RAW_MESSAGE), { resolver: passingResolver() });
		expect(outcome.result).toBe('none');
	});
});

describe('integration: onData threads dkimResult into mailboxPayload', () => {
	it('a personal-mailbox delivery carries the DKIM verdict', async () => {
		// Reuse the bounce reducer to assert the verdict lands on the
		// inbound.mailbox.received payload, mirroring what onData produces.
		const { reduce } = await import('../outcome.js');
		const { simpleParser } = await import('mailparser');

		const parsed = await simpleParser(signedMessage);
		const dkim = await verifyDkim(signedMessage, { resolver: passingResolver() });

		const reduction = reduce(
			{
				kind: 'mailbox',
				mailbox: {
					organizationId: 'org_1',
					recipientAddress: 'me@example.com',
					quotaBytes: null,
					usedBytes: 0,
				} as never,
				rcptTo: 'me@example.com',
				attachments: [],
				toAddrs: ['me@example.com'],
				ccAddrs: [],
				bccAddrs: [],
				references: undefined,
				dkimResult: dkim.result,
			},
			// The reducer consumes the in-house `ParsedMessage`; this test parses via
			// the mailparser oracle (I1) and casts at the ctx boundary.
			{
				parsed: parsed as unknown as ParsedMessage,
				rawBuffer: signedMessage,
				rcptTo: 'me@example.com',
			}
		);

		const notify = reduction.effects.find((e) => e.kind === 'notify_convex');
		expect(notify).toBeDefined();
		if (notify && notify.kind === 'notify_convex') {
			expect(notify.event.event).toBe('inbound.mailbox.received');
			expect(notify.event.mailboxPayload?.dkimResult).toBe('pass');
		}
	});
});
