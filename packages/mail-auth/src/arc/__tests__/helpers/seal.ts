/**
 * Shared ARC corpus builders for the `verifyArc` test suites.
 *
 * The differential suite signs REAL ARC chains with the retained `mailauth`
 * oracle (locked decision I1: `mailauth` stays a devDependency so the tests are
 * not self-referential) and asserts our verdict equals the oracle's. `mailauth`
 * 4.13.x can only produce and verify RSA ARC chains — its `verifyAS` omits the
 * SHA-256 pre-hash its own signer applies for Ed25519, so an Ed25519 ARC set
 * never verifies against it. The one Ed25519-seal fixture is therefore a
 * signer→verifier ROUND TRIP (`mintEd25519Seal`), minted here over the SHARED
 * `@owlat/mail-auth` canon exactly as a conformant sealer would, and consumed by
 * our verifier — the only way to exercise the Ed25519 seal path at all.
 */

import { generateKeyPairSync, createHash, sign as cryptoSign, type KeyObject } from 'crypto';
import { sealMessage } from 'mailauth/lib/arc/index.js';
import { dkimVerify } from 'mailauth/lib/dkim/verify.js';
import { arc } from 'mailauth/lib/arc/index.js';
import { canonicalizeHeaderField, stripSignatureValue } from '../../../canon.js';
import { splitMessage, type HeaderField } from '../../../dkim/message.js';

/** A resolver accepted by BOTH our verifier and the `mailauth` oracle. */
export type ArcTestResolver = (name: string, rrtype: string) => Promise<string[][]>;

/** `<selector>._domainkey.<domain>` -> TXT key record. */
export type KeyManifest = Record<string, string>;

/** A generated RSA key: the signing half plus its published TXT record. */
export interface RsaKey {
	readonly privateKey: KeyObject;
	readonly txt: string;
}

/** A generated Ed25519 key: the signing half plus its published TXT record. */
export interface Ed25519Key {
	readonly privateKey: KeyObject;
	readonly txt: string;
}

/** Generate an RSA-2048 key and its `k=rsa` DKIM TXT record. */
export function makeRsaKey(): RsaKey {
	const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const der = publicKey.export({ type: 'spki', format: 'der' });
	return { privateKey, txt: `v=DKIM1; k=rsa; p=${der.toString('base64')}` };
}

/** Generate an Ed25519 key and its `k=ed25519` DKIM TXT record (raw 32-byte p=). */
export function makeEd25519Key(): Ed25519Key {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	const spki = publicKey.export({ type: 'spki', format: 'der' });
	const raw = spki.subarray(spki.length - 32).toString('base64');
	return { privateKey, txt: `v=DKIM1; k=ed25519; p=${raw}` };
}

/** A hermetic TXT resolver over a fixed key manifest; ENOTFOUND otherwise. */
export function resolverFor(keys: KeyManifest): ArcTestResolver {
	return async (name, rrtype) => {
		const record = keys[name];
		if (rrtype === 'TXT' && record !== undefined) {
			return [[record]];
		}
		const err = new Error(`ENOTFOUND ${name}`) as Error & { code: string };
		err.code = 'ENOTFOUND';
		throw err;
	};
}

/** The base author message every fixture is sealed over. */
export const BASE_MESSAGE = Buffer.from(
	[
		'From: Alice Author <alice@author.example>',
		'To: list@lists.example',
		'Subject: [list] hello from the mailing list',
		'Date: Tue, 01 Jul 2025 12:00:00 +0000',
		'Message-ID: <arc-corpus-001@author.example>',
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=utf-8',
		'',
		'This is a mailing-list message whose author DKIM was broken by the list.',
		'',
	].join('\r\n'),
	'latin1'
);

/** Options for sealing one ARC hop with the `mailauth` oracle. */
export interface SealHopOptions {
	readonly domain: string;
	readonly selector: string;
	readonly privateKey: KeyObject;
	readonly instance: number;
	readonly cv: 'none' | 'pass' | 'fail';
	readonly authResults: string;
	readonly algorithm?: 'rsa-sha256' | 'ed25519-sha256';
}

/** Seal `input` as one more ARC hop with `mailauth`, returning the sealed message. */
export async function sealHop(input: Buffer, opts: SealHopOptions): Promise<Buffer> {
	const headers = await sealMessage(input, {
		signingDomain: opts.domain,
		selector: opts.selector,
		// `mailauth`'s `getPrivateKey` only accepts a PEM string / Buffer (or a raw
		// 32-byte Ed25519 key), NOT a Node `KeyObject`: handed a `KeyObject` its
		// `crypto.sign` throws internally, the AMS is silently dropped, and the
		// emitted "chain" has no ARC-Message-Signature — which its own `arc()` then
		// rejects. Export to pkcs8 PEM so the oracle produces a chain it validates.
		privateKey: opts.privateKey.export({ type: 'pkcs8', format: 'pem' }),
		algorithm: opts.algorithm ?? 'rsa-sha256',
		cv: opts.cv,
		i: opts.instance,
		authResults: opts.authResults,
	} as unknown as Parameters<typeof sealMessage>[1]);
	return Buffer.concat([headers, input]);
}

/** The `mailauth` ARC chain-validation verdict, reduced to our vocabulary. */
export async function mailauthArcCv(
	message: Buffer,
	resolver: ArcTestResolver
): Promise<'pass' | 'fail' | 'none'> {
	const verified = (await dkimVerify(message, { resolver })) as { arc?: unknown };
	const result = (await arc(
		verified.arc as Parameters<typeof arc>[0],
		{ resolver } as Parameters<typeof arc>[1]
	)) as { status?: { result?: string } };
	const raw = (result.status?.result ?? '').toLowerCase();
	if (raw === 'pass') return 'pass';
	if (raw === 'fail') return 'fail';
	return 'none';
}

/** Find the (single) header field of a given lowercase name in a raw block. */
function headerNamed(fields: readonly HeaderField[], name: string): HeaderField {
	const field = fields.find((f) => f.name === name);
	if (field === undefined) {
		throw new Error(`fixture is missing a ${name} header`);
	}
	return field;
}

/**
 * Mint a conformant Ed25519 ARC-Seal (i=1, cv=none) over the AAR + AMS produced
 * by an existing RSA seal of `BASE_MESSAGE`, reusing the SHARED canon exactly as
 * `verifyArc` does. The RSA AMS stays intact (verifiable against `rsaKey`); only
 * the seal becomes Ed25519. Returns the reassembled message + the key manifest.
 *
 * This is the signer→verifier round trip the `mailauth` oracle cannot stand in
 * for (its Ed25519 ARC verify is broken), so the seal is signed here with raw
 * `node:crypto` and the shared canon — never by calling our verifier.
 */
export function mintEd25519Seal(input: {
	readonly sealerDomain: string;
	readonly sealerSelector: string;
	readonly edPrivateKey: KeyObject;
	readonly rsaSealed: Buffer;
}): Buffer {
	const { headerFields } = splitMessage(input.rsaSealed);
	const aar = headerNamed(headerFields, 'arc-authentication-results');
	const ams = headerNamed(headerFields, 'arc-message-signature');

	const template =
		`ARC-Seal: i=1; a=ed25519-sha256; d=${input.sealerDomain}; ` +
		`s=${input.sealerSelector}; t=1783902765; cv=none; b=`;
	const signingInput = Buffer.concat([
		Buffer.from(`${canonicalizeHeaderField(aar.raw, 'relaxed')}\r\n`, 'latin1'),
		Buffer.from(`${canonicalizeHeaderField(ams.raw, 'relaxed')}\r\n`, 'latin1'),
		Buffer.from(canonicalizeHeaderField(stripSignatureValue(template), 'relaxed'), 'latin1'),
	]);
	const signature = cryptoSign(
		null,
		createHash('sha256').update(signingInput).digest(),
		input.edPrivateKey
	).toString('base64');
	const seal = `${template}${signature}`;

	const headers = `${seal}\r\n${ams.raw}\r\n${aar.raw}\r\n`;
	return Buffer.concat([Buffer.from(headers, 'latin1'), BASE_MESSAGE]);
}

/** Flip one base64 char of a header's `b=` value to corrupt the signature. */
export function corruptSignature(message: Buffer, headerName: string): Buffer {
	const text = message.toString('latin1');
	const headerIdx = text.indexOf(`${headerName}:`);
	if (headerIdx === -1) {
		throw new Error(`no ${headerName} header to corrupt`);
	}
	const bIdx = text.indexOf('b=', headerIdx);
	// Skip a folded `bh=` by landing on a `b=` that is not preceded by another letter.
	const sigCharIdx = bIdx + 2;
	const original = text[sigCharIdx] ?? 'A';
	const replacement = original === 'A' ? 'B' : 'A';
	return Buffer.from(
		text.slice(0, sigCharIdx) + replacement + text.slice(sigCharIdx + 1),
		'latin1'
	);
}
