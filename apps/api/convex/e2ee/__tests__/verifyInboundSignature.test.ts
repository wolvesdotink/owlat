/**
 * Inbound PGP signature verification — the F1 hard gate for
 * `e2ee/verifyInboundSignature.ts` (the delivery-side ingest matrix lives in
 * `mail/__tests__/deliverySignedIngest.integration.test.ts`). Every verdict is
 * asserted for FAILURE HONESTY: nothing throws into ingest, `isSignatureValid`
 * is true ONLY when the crypto verified against the pinned/discovered key, and
 * each failure state is recorded distinctly:
 *   - valid detached (RFC 3156)      → verified + fingerprint, keySource pinned
 *   - valid clearsigned (inline)     → verified + fingerprint
 *   - tampered body                  → invalid, no failure annotation
 *   - wrong (impostor) pinned key    → invalid, never "verified"
 *   - key not found                  → invalid, keySource 'not_found'
 *   - key CHANGED (pin conflict)     → refusal, failure 'key_changed'
 *   - malformed signature part       → failure 'malformed_signature'
 * Clearsigned bodies are verified over the octets that were signed (#1300):
 * 8-bit UTF-8, 8-bit ISO-8859-1, quoted-printable and base64 bodies all verify,
 * and a changed octet or a body re-encoded in another charset does not.
 * Plus the WKD-first ladder: `skipManifest` discovery never touches the
 * instance manifest (D9), while the sealed path's default still does.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import * as openpgp from 'openpgp';
import { parseBody } from '@owlat/mail-message/parse/body';
import { extractClearsignedText } from '@owlat/shared/secureMessage';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { discoverKeyForAddress } from '../discovery';
import { type DiscoveryDeps } from '../discoveryFetch';
import { verifyDetachedSignature, verifyClearsignedBody } from '../verifyInboundSignature';
import {
	generateTestKeypair,
	modules,
	seedPinnedSender,
	type ConvexTestCtx,
} from './sealedMailTestHelpers';
import {
	clearsign,
	clearsignOctets,
	composeClearsignedMessage,
	type ClearsignedBodyEncoding,
	composeSignedPgpMime,
	detachedSign,
	signedFirstPart,
} from './signedMailTestHelpers';
import {
	GPG_CLEARSIGNED_ASCII_BASE64,
	GPG_CLEARSIGNED_LATIN1_BASE64,
	GPG_PUBLIC_KEY,
} from './gpgClearsignedFixtures';

const SENDER = 'alice@sender.test';
const RECIPIENT = 'me@example.com';
const CANARY = 'CANARY_INBOUND_SIGNED_4d7f21';

type T = ConvexTestCtx;

async function composeDetached(privateKeyArmored: string): Promise<string> {
	const part = signedFirstPart(`Signed ${CANARY} content.`);
	return composeSignedPgpMime({
		from: SENDER,
		to: RECIPIENT,
		subject: 'signed message',
		part,
		signatureArmored: await detachedSign(part, privateKeyArmored),
		messageId: '<signed-f1-0001@sender.test>',
	});
}

async function runVerify(t: T, raw: string, rawEncoding: BufferEncoding = 'utf8') {
	return await t.action(internal.e2ee.verifyInboundSignature.forInbound, {
		rawBytesBase64: Buffer.from(raw, rawEncoding).toString('base64'),
		from: SENDER,
	});
}

async function pinSender(t: T, publicKeyArmored: string): Promise<void> {
	await seedPinnedSender(t, {
		address: SENDER,
		domain: 'sender.test',
		pinnedPublicKeyArmored: publicKeyArmored,
	});
}

const VERIFIED_PINNED = (fingerprint: string) => ({
	isSigned: true,
	info: {
		isSigned: true,
		isSignatureValid: true,
		signerFingerprint: fingerprint,
		keySource: 'pinned',
	},
});

describe('e2ee.verifyInboundSignature.forInbound — verdict matrix', () => {
	it('valid detached (RFC 3156) against the pinned key ⇒ verified + fingerprint', async () => {
		const t = convexTest(schema, modules);
		const sender = await generateTestKeypair(SENDER);
		await pinSender(t, sender.publicKeyArmored);

		const result = await runVerify(t, await composeDetached(sender.privateKeyArmored));
		expect(result).toEqual({
			isSigned: true,
			info: {
				isSigned: true,
				isSignatureValid: true,
				signerFingerprint: sender.fingerprint,
				keySource: 'pinned',
			},
		});
	});

	it('valid clearsigned body ⇒ verified inline + fingerprint', async () => {
		const t = convexTest(schema, modules);
		const sender = await generateTestKeypair(SENDER);
		await pinSender(t, sender.publicKeyArmored);

		const raw = composeClearsignedMessage({
			from: SENDER,
			to: RECIPIENT,
			subject: 'clearsigned message',
			clearsignArmor: await clearsign(`Clear ${CANARY} text.`, sender.privateKeyArmored),
			messageId: '<clearsigned-f1-0001@sender.test>',
		});
		const result = await runVerify(t, raw);
		expect(result).toEqual({
			isSigned: true,
			info: {
				isSigned: true,
				isSignatureValid: true,
				signerFingerprint: sender.fingerprint,
				keySource: 'pinned',
			},
		});
	});

	it('tampered body ⇒ isSignatureValid:false (no fingerprint, no annotation)', async () => {
		const t = convexTest(schema, modules);
		const sender = await generateTestKeypair(SENDER);
		await pinSender(t, sender.publicKeyArmored);

		const raw = (await composeDetached(sender.privateKeyArmored)).replace(CANARY, 'TAMPERED_BODY');
		const result = await runVerify(t, raw);
		expect(result).toEqual({
			isSigned: true,
			info: { isSigned: true, isSignatureValid: false, keySource: 'pinned' },
		});
	});

	it('wrong pinned key (impostor) ⇒ invalid, never "verified"', async () => {
		const t = convexTest(schema, modules);
		const sender = await generateTestKeypair(SENDER);
		const impostor = await generateTestKeypair('mallory@evil.test');
		await pinSender(t, impostor.publicKeyArmored);

		const result = await runVerify(t, await composeDetached(sender.privateKeyArmored));
		expect(result).toEqual({
			isSigned: true,
			info: { isSigned: true, isSignatureValid: false, keySource: 'pinned' },
		});
	});

	it('key not found (no pin, discovery yields nothing) ⇒ honest not_found verdict', async () => {
		const t = convexTest(schema, modules);
		const sender = await generateTestKeypair(SENDER);
		// No pin seeded and no instanceSettings ⇒ discovery is the same flag-gated
		// no-op sealed mail has; the verdict must stay honest, not throw.
		const result = await runVerify(t, await composeDetached(sender.privateKeyArmored));
		expect(result).toEqual({
			isSigned: true,
			info: { isSigned: true, isSignatureValid: false, keySource: 'not_found' },
		});
	});

	it('key CHANGED (TOFU pin conflict) ⇒ pin refusal, failure key_changed', async () => {
		const t = convexTest(schema, modules);
		const sender = await generateTestKeypair(SENDER);
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('recipientKeys', {
				address: SENDER,
				domain: 'sender.test',
				outcome: 'keyChanged',
				pinnedFingerprint: 'OLDFP',
				pinnedPublicKeyArmored: sender.publicKeyArmored,
				observedFingerprint: 'NEWFP',
				expiresAt: now + 60_000,
				discoveredAt: now,
				updatedAt: now,
			});
		});

		// Even a signature that WOULD verify against the old pin is refused —
		// identical fail-closed pin handling to sealed mail.
		const result = await runVerify(t, await composeDetached(sender.privateKeyArmored));
		expect(result).toEqual({
			isSigned: true,
			info: {
				isSigned: true,
				isSignatureValid: false,
				keySource: 'pinned',
				failure: 'key_changed',
			},
		});
	});

	it('malformed signature part ⇒ failure malformed_signature (delivers, never throws)', async () => {
		const t = convexTest(schema, modules);
		const sender = await generateTestKeypair(SENDER);
		await pinSender(t, sender.publicKeyArmored);

		const part = signedFirstPart('Some signed content.');
		const raw = composeSignedPgpMime({
			from: SENDER,
			to: RECIPIENT,
			subject: 'broken signature',
			part,
			signatureArmored: [
				'-----BEGIN PGP SIGNATURE-----',
				'',
				'not!valid!armor!!!',
				'-----END PGP SIGNATURE-----',
			].join('\n'),
			messageId: '<malformed-f1-0001@sender.test>',
		});
		const result = await runVerify(t, raw);
		expect(result).toEqual({
			isSigned: true,
			info: {
				isSigned: true,
				isSignatureValid: false,
				keySource: 'pinned',
				failure: 'malformed_signature',
			},
		});
	});

	it('a plaintext message is not signed ⇒ { isSigned: false } (untouched fast path)', async () => {
		const t = convexTest(schema, modules);
		const raw = 'From: a@b.c\r\nSubject: plain\r\n\r\nJust text.\r\n';
		expect(await runVerify(t, raw)).toEqual({ isSigned: false });
	});
});

describe('clearsigned bodies verify over the octets that were signed (#1300)', () => {
	const GREETING = 'Grüße aus Köln,\nund ein Gruß an Jürgen.\n\n-- \nAlice';
	// A line well past 76 columns, so a quoted-printable body soft-breaks it.
	const LONG = `${'Größenordnung äöü '.repeat(8)}Ende`;
	const latin1 = (text: string) => new Uint8Array(Buffer.from(text, 'latin1'));
	const utf8 = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'));

	const VERIFIED = (fingerprint: string) => ({
		isSigned: true,
		info: {
			isSigned: true,
			isSignatureValid: true,
			signerFingerprint: fingerprint,
			keySource: 'pinned',
		},
	});
	const NOT_VERIFIED = {
		isSigned: true,
		info: { isSigned: true, isSignatureValid: false, keySource: 'pinned' },
	};

	async function signedMessage(args: {
		octets: Uint8Array;
		privateKeyArmored: string;
		charset: string;
		encoding: ClearsignedBodyEncoding;
		tamper?: (armor: string) => string;
	}): Promise<string> {
		const armor = await clearsignOctets(args.octets, args.privateKeyArmored);
		return composeClearsignedMessage({
			from: SENDER,
			to: RECIPIENT,
			subject: 'clearsigned',
			clearsignArmor: args.tamper ? args.tamper(armor) : armor,
			messageId: '<clearsigned-octets@sender.test>',
			charset: args.charset,
			encoding: args.encoding,
		});
	}

	const cases: Array<[string, Uint8Array, string, ClearsignedBodyEncoding]> = [
		['8-bit UTF-8', utf8(GREETING), 'utf-8', '8bit'],
		['8-bit ISO-8859-1', latin1(GREETING), 'iso-8859-1', '8bit'],
		['quoted-printable UTF-8', utf8(`${GREETING}\n${LONG}`), 'utf-8', 'quoted-printable'],
		[
			'quoted-printable ISO-8859-1',
			latin1(`${GREETING}\n${LONG}`),
			'iso-8859-1',
			'quoted-printable',
		],
		['base64 UTF-8', utf8(GREETING), 'utf-8', 'base64'],
	];

	it.each(cases)('a %s body verifies', async (_label, octets, charset, encoding) => {
		const t = convexTest(schema, modules);
		const sender = await generateTestKeypair(SENDER);
		await pinSender(t, sender.publicKeyArmored);

		const raw = await signedMessage({
			octets,
			privateKeyArmored: sender.privateKeyArmored,
			charset,
			encoding,
		});
		expect(await runVerify(t, raw, 'latin1')).toEqual(VERIFIED(sender.fingerprint));
	});

	it.each(cases)(
		'a %s body with one octet changed does not verify',
		async (_label, octets, charset, encoding) => {
			const t = convexTest(schema, modules);
			const sender = await generateTestKeypair(SENDER);
			await pinSender(t, sender.publicKeyArmored);

			// Köln → Kölm: the last octet of a word inside the signed text.
			const raw = await signedMessage({
				octets,
				privateKeyArmored: sender.privateKeyArmored,
				charset,
				encoding,
				tamper: (armor) => armor.replace('ln,', 'lm,'),
			});
			expect(await runVerify(t, raw, 'latin1')).toEqual(NOT_VERIFIED);
		}
	);

	it('an ISO-8859-1 body with a non-ASCII octet changed does not verify', async () => {
		const t = convexTest(schema, modules);
		const sender = await generateTestKeypair(SENDER);
		await pinSender(t, sender.publicKeyArmored);

		// ü (0xFC) → ý (0xFD): only the 8-bit octet differs.
		const raw = await signedMessage({
			octets: latin1(GREETING),
			privateKeyArmored: sender.privateKeyArmored,
			charset: 'iso-8859-1',
			encoding: '8bit',
			tamper: (armor) => armor.replace('Gr\xfc\xdfe', 'Gr\xfd\xdfe'),
		});
		expect(await runVerify(t, raw, 'latin1')).toEqual(NOT_VERIFIED);
	});

	it('the same text re-encoded in another charset, under that label, does not verify', async () => {
		const t = convexTest(schema, modules);
		const sender = await generateTestKeypair(SENDER);
		await pinSender(t, sender.publicKeyArmored);

		// Signed as UTF-8 octets; a relay transcodes the body to ISO-8859-1 and
		// relabels it. The text reads the same, the signed octets are gone.
		const armor = await clearsignOctets(utf8(GREETING), sender.privateKeyArmored);
		const transcoded = Buffer.from(
			Buffer.from(armor, 'latin1').toString('utf8'),
			'latin1'
		).toString('latin1');
		expect(transcoded).not.toBe(armor);
		for (const encoding of ['8bit', 'quoted-printable', 'base64'] as const) {
			const raw = composeClearsignedMessage({
				from: SENDER,
				to: RECIPIENT,
				subject: 'clearsigned',
				clearsignArmor: transcoded,
				messageId: '<clearsigned-transcoded@sender.test>',
				charset: 'iso-8859-1',
				encoding,
			});
			expect(await runVerify(t, raw, 'latin1')).toEqual(NOT_VERIFIED);
		}
	});

	it('a base64 body is recognised as clearsigned at all', async () => {
		const t = convexTest(schema, modules);
		const sender = await generateTestKeypair(SENDER);
		await pinSender(t, sender.publicKeyArmored);

		const raw = await signedMessage({
			octets: utf8(GREETING),
			privateKeyArmored: sender.privateKeyArmored,
			charset: 'utf-8',
			encoding: 'base64',
		});
		expect(raw).not.toContain('BEGIN PGP SIGNED MESSAGE');
		expect((await runVerify(t, raw, 'latin1')).isSigned).toBe(true);
	});
});

describe('the verified block is the one the reader displays (#1300)', () => {
	/** A multipart/mixed message of `parts` (header lines + body lines each). */
	function mixed(parts: Array<[string[], string]>): string {
		return [
			`From: ${SENDER}`,
			`To: ${RECIPIENT}`,
			'Subject: clearsigned with parts',
			'MIME-Version: 1.0',
			'Content-Type: multipart/mixed; boundary="mx"',
			'',
			...parts.flatMap(([headers, body]) => ['--mx', ...headers, '', body]),
			'--mx--',
			'',
		].join('\r\n');
	}
	const crlf = (armor: string) => armor.trim().replace(/\n/g, '\r\n');
	const base64Lines = (armor: string) =>
		(
			Buffer.from(crlf(armor), 'utf8')
				.toString('base64')
				.match(/.{1,76}/g) ?? []
		).join('\r\n');
	const BODY = ['Content-Type: text/plain; charset=utf-8'];
	const ATTACHED = [
		'Content-Type: text/plain; charset=utf-8; name="signed.txt"',
		'Content-Disposition: attachment; filename="signed.txt"',
		'Content-Transfer-Encoding: base64',
	];

	async function pinned() {
		const t = convexTest(schema, modules);
		const sender = await generateTestKeypair(SENDER);
		await pinSender(t, sender.publicKeyArmored);
		return { t, sender };
	}

	it('a signed ATTACHMENT next to an altered visible body does not verify', async () => {
		const { t, sender } = await pinned();
		const signed = await clearsign(`Pay ${CANARY} 10 EUR.`, sender.privateKeyArmored);
		const raw = mixed([
			[ATTACHED, base64Lines(signed)],
			[BODY, crlf(signed.replace('10 EUR', '9000 EUR'))],
		]);
		expect(await runVerify(t, raw)).toEqual({
			isSigned: true,
			info: { isSigned: true, isSignatureValid: false, keySource: 'pinned' },
		});
	});

	it('a signed ATTACHMENT under an unsigned visible body is not a signed message', async () => {
		const { t, sender } = await pinned();
		const signed = await clearsign(`Pay ${CANARY} 10 EUR.`, sender.privateKeyArmored);
		const raw = mixed([
			[BODY, 'Nothing signed up here.'],
			[ATTACHED, base64Lines(signed)],
		]);
		expect(await runVerify(t, raw)).toEqual({ isSigned: false });
	});

	it('a signed visible body next to an unrelated attachment verifies', async () => {
		const { t, sender } = await pinned();
		const signed = await clearsign(`Clear ${CANARY} text.`, sender.privateKeyArmored);
		const raw = mixed([
			[BODY, crlf(signed)],
			[
				['Content-Type: application/pdf; name="a.pdf"', 'Content-Transfer-Encoding: base64'],
				Buffer.from('%PDF-1.4 unrelated').toString('base64'),
			],
		]);
		expect(await runVerify(t, raw)).toEqual(VERIFIED_PINNED(sender.fingerprint));
	});

	it('two text body parts around a signed one verify, as on main (the signed part is the one shown)', async () => {
		const { t, sender } = await pinned();
		const signed = await clearsign(`Clear ${CANARY} text.`, sender.privateKeyArmored);
		const raw = mixed([
			[BODY, crlf(signed)],
			[BODY, 'Mailing list footer, added in transit.'],
		]);
		expect(await runVerify(t, raw)).toEqual(VERIFIED_PINNED(sender.fingerprint));
	});

	/** A base64 body part (so any octets survive) under `charset`. */
	const base64Part = (charset: string, bytes: Buffer): [string[], string] => [
		[`Content-Type: text/plain; charset=${charset}`, 'Content-Transfer-Encoding: base64'],
		(bytes.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n'),
	];
	/** The signed text the reader shows: its own body assembly and extractor. */
	const readerShows = (raw: string) => extractClearsignedText(parseBody(raw).text ?? '');
	const MALFORMED = {
		isSigned: true,
		info: {
			isSigned: true,
			isSignatureValid: false,
			keySource: 'pinned',
			failure: 'malformed_signature',
		},
	};

	it('an altered UTF-16 block shown above the valid ASCII one does not verify', async () => {
		const { t, sender } = await pinned();
		const signed = await clearsign(`Pay ${CANARY} 10 EUR.`, sender.privateKeyArmored);
		const altered = signed.replace('10 EUR', '9000 EUR');
		const raw = mixed([
			base64Part('utf-16le', Buffer.from(crlf(altered), 'utf16le')),
			base64Part('us-ascii', Buffer.from(crlf(signed), 'latin1')),
		]);
		// What the reader displays is the altered block.
		expect(readerShows(raw)).toBe(`Pay ${CANARY} 9000 EUR.`);
		expect(await runVerify(t, raw, 'latin1')).toEqual(MALFORMED);
	});

	it('a valid block in a UTF-16 part does not verify (not an ASCII-compatible charset)', async () => {
		const { t, sender } = await pinned();
		const signed = await clearsign(`Clear ${CANARY} text.`, sender.privateKeyArmored);
		const raw = mixed([base64Part('utf-16le', Buffer.from(crlf(signed), 'utf16le'))]);
		expect(readerShows(raw)).toBe(`Clear ${CANARY} text.`);
		expect(await runVerify(t, raw, 'latin1')).toEqual(MALFORMED);
	});

	it('two valid blocks in one body do not verify', async () => {
		const { t, sender } = await pinned();
		const first = await clearsign(`First ${CANARY}.`, sender.privateKeyArmored);
		const second = await clearsign(`Second ${CANARY}.`, sender.privateKeyArmored);
		const raw = mixed([[BODY, crlf(`${first}\n\n${second}`)]]);
		expect(await runVerify(t, raw)).toEqual(MALFORMED);
	});

	it('a single ISO-8859-1 block verifies, and the reader shows the text that was signed', async () => {
		const { t, sender } = await pinned();
		const armor = await clearsignOctets(
			new Uint8Array(Buffer.from(`Grüße aus Köln, ${CANARY}.`, 'latin1')),
			sender.privateKeyArmored
		);
		const raw = mixed([
			[BODY, 'Unsigned preamble part.'],
			base64Part('iso-8859-1', Buffer.from(crlf(armor), 'latin1')),
		]);
		expect(readerShows(raw)).toBe(`Grüße aus Köln, ${CANARY}.`);
		expect(await runVerify(t, raw, 'latin1')).toEqual(VERIFIED_PINNED(sender.fingerprint));
	});

	it('a bare body (the AI-inbox mirror) still verifies as a whole', async () => {
		const { t, sender } = await pinned();
		const signed = await clearsign(`Clear ${CANARY} text.`, sender.privateKeyArmored);
		const bare = `Signed as always.\n\n${signed}`;
		const result = await t.action(internal.e2ee.verifyInboundSignature.forInbound, {
			rawBytesBase64: Buffer.from(bare, 'utf8').toString('base64'),
			from: SENDER,
			bareBody: true,
		});
		expect(result).toEqual(VERIFIED_PINNED(sender.fingerprint));
	});
});

describe('GnuPG-made clearsigned bodies, and a CR that ends no line (#1300)', () => {
	const gpgBody = (base64: string) => Buffer.from(base64, 'base64').toString('latin1');
	const fixtures: Array<[string, string]> = [
		['ASCII', GPG_CLEARSIGNED_ASCII_BASE64],
		['ISO-8859-1', GPG_CLEARSIGNED_LATIN1_BASE64],
	];

	it.each(fixtures)('the %s message verifies', async (_label, base64) => {
		expect(await verifyClearsignedBody(gpgBody(base64), GPG_PUBLIC_KEY)).toMatchObject({
			verified: true,
		});
	});

	it.each(fixtures)(
		'the %s message with a bare CR inside a word does not verify',
		async (_label, base64) => {
			// gpg --verify: BAD signature. openpgp.js alone drops the CR and verifies.
			const tampered = gpgBody(base64).replace('aus', 'a\rus');
			expect(await verifyClearsignedBody(tampered, GPG_PUBLIC_KEY)).toEqual({ verified: false });
		}
	);

	it.each(fixtures)(
		'the %s message with a stray CR before a line end does not verify',
		async (_label, base64) => {
			const tampered = gpgBody(base64).replace(',\n', ',\r\r\n');
			expect(await verifyClearsignedBody(tampered, GPG_PUBLIC_KEY)).toEqual({ verified: false });
		}
	);

	it('CRLF line ends are not bare CRs: the CRLF form of the ISO-8859-1 message verifies', async () => {
		const crlfBody = gpgBody(GPG_CLEARSIGNED_LATIN1_BASE64).replace(/\n/g, '\r\n');
		expect(await verifyClearsignedBody(crlfBody, GPG_PUBLIC_KEY)).toMatchObject({ verified: true });
	});
});

describe('verify primitives — detached + clearsigned', () => {
	it('verifyDetachedSignature round-trips and rejects a byte flip', async () => {
		const sender = await generateTestKeypair(SENDER);
		const part = signedFirstPart('primitive check');
		const armor = await detachedSign(part, sender.privateKeyArmored);
		const bytes = Buffer.from(part, 'utf8');

		const ok = await verifyDetachedSignature(bytes, armor, sender.publicKeyArmored);
		expect(ok).toEqual({ verified: true, signerFingerprint: sender.fingerprint });

		const flipped = Buffer.from(part.replace('primitive', 'primitivE'), 'utf8');
		expect(await verifyDetachedSignature(flipped, armor, sender.publicKeyArmored)).toEqual({
			verified: false,
		});
		expect(await verifyDetachedSignature(bytes, 'garbage', sender.publicKeyArmored)).toEqual({
			verified: false,
			malformed: true,
		});
	});

	it('verifyClearsignedBody verifies a CRLF-embedded block and flags a missing one', async () => {
		const sender = await generateTestKeypair(SENDER);
		const armor = await clearsign('inline body', sender.privateKeyArmored);
		const crlfBody = `Preamble\r\n${armor.replace(/\n/g, '\r\n')}\r\n`;
		expect(await verifyClearsignedBody(crlfBody, sender.publicKeyArmored)).toEqual({
			verified: true,
			signerFingerprint: sender.fingerprint,
		});
		expect(await verifyClearsignedBody('no armor here', sender.publicKeyArmored)).toEqual({
			verified: false,
			malformed: true,
		});
	});
});

describe('WKD-first discovery (D9: skipManifest)', () => {
	async function wkdDeps(address: string, publicKeyArmored: string) {
		const binary = (await openpgp.readKey({ armoredKey: publicKeyArmored })).write();
		const fetched: string[] = [];
		const deps: DiscoveryDeps = {
			lookup: async () => [{ address: '93.184.216.34' }],
			fetch: async (input) => {
				const url = String(input);
				fetched.push(url);
				if (url.includes('/.well-known/openpgpkey/hu/')) {
					return new Response(binary.slice(), { status: 200 });
				}
				return new Response(null, { status: 404 });
			},
		};
		return { deps, fetched };
	}

	it('skipManifest goes straight to WKD — the manifest URL is never fetched', async () => {
		const sender = await generateTestKeypair(SENDER);
		const { deps, fetched } = await wkdDeps(SENDER, sender.publicKeyArmored);

		const result = await discoverKeyForAddress(SENDER, deps, { skipManifest: true });
		expect(result.outcome).toBe('found');
		if (result.outcome !== 'found') return;
		expect(result.source).toBe('wkd');
		expect(result.fingerprint).toBe(sender.fingerprint);
		expect(fetched.some((u) => u.includes('owlat.json'))).toBe(false);
		expect(fetched.some((u) => u.includes('/.well-known/openpgpkey/hu/'))).toBe(true);
	});

	it('the default (sealed) ladder still fetches the manifest first', async () => {
		const sender = await generateTestKeypair(SENDER);
		const { deps, fetched } = await wkdDeps(SENDER, sender.publicKeyArmored);

		const result = await discoverKeyForAddress(SENDER, deps);
		expect(result.outcome).toBe('found');
		expect(fetched.some((u) => u.includes('owlat.json'))).toBe(true);
	});
});
