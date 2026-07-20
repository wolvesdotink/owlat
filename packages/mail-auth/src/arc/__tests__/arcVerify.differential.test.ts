/**
 * ARC verifier — VERDICT EQUALITY vs the `mailauth` oracle (I1: `mailauth` is
 * retained as a devDependency so these differential tests are not
 * self-referential).
 *
 * For every RSA fixture we seal a real ARC chain with `mailauth`'s `sealMessage`,
 * publish the matching keys through a mocked TXT resolver, and assert that OUR
 * `verifyArc` chain-validation state (`cv`) equals `mailauth`'s `arc()` result.
 *
 * Covered: a valid 1-hop chain, a valid 2-hop chain (Google→Microsoft style
 * re-sealing), a Microsoft-style transport REFOLD of a signed header (relaxed
 * canon absorbs it → still pass), a broken AMS body hash, a tampered outer
 * ARC-Seal, a `cv=fail` outer seal, and a 2-hop whose INNER seal is tampered (no
 * later hop can rescue it). Each valid case additionally pins the honest
 * `sealerDomain` + `attestsOriginalPass` the trust layer consumes.
 *
 * Ed25519 seals get a dedicated signer→verifier round trip: `mailauth` 4.13.x
 * cannot verify Ed25519 ARC (its `verifyAS` drops the SHA-256 pre-hash its signer
 * applies), so it cannot be the oracle there — the conformant Ed25519 seal is
 * minted over the shared canon and asserted to verify (and, when tampered, fail).
 */

import { describe, it, expect } from 'vitest';
import { verifyArc } from '../verify.js';
import {
	BASE_MESSAGE,
	makeEd25519Key,
	makeRsaKey,
	mailauthArcCv,
	mintEd25519Seal,
	resolverFor,
	sealHop,
	corruptSignature,
	type ArcTestResolver,
	type KeyManifest,
} from './helpers/seal.js';

const AAR_PASS =
	'lists.sourceforge.net; dmarc=pass header.from=author.example; ' +
	'spf=pass smtp.mailfrom=lists.example; dkim=pass header.d=author.example';

/** Build a valid 1-hop RSA chain sealed by `lists.sourceforge.net`. */
async function oneHop(): Promise<{ message: Buffer; resolver: ArcTestResolver }> {
	const key = makeRsaKey();
	const keys: KeyManifest = { 'arc1._domainkey.lists.sourceforge.net': key.txt };
	const message = await sealHop(BASE_MESSAGE, {
		domain: 'lists.sourceforge.net',
		selector: 'arc1',
		privateKey: key.privateKey,
		instance: 1,
		cv: 'none',
		authResults: AAR_PASS,
	});
	return { message, resolver: resolverFor(keys) };
}

/** Build a valid 2-hop RSA chain: author list (i=1) then a downstream relay (i=2). */
async function twoHop(): Promise<{ message: Buffer; resolver: ArcTestResolver }> {
	const hop1 = makeRsaKey();
	const hop2 = makeRsaKey();
	const keys: KeyManifest = {
		'arc1._domainkey.lists.sourceforge.net': hop1.txt,
		'arc2._domainkey.relay.example': hop2.txt,
	};
	const first = await sealHop(BASE_MESSAGE, {
		domain: 'lists.sourceforge.net',
		selector: 'arc1',
		privateKey: hop1.privateKey,
		instance: 1,
		cv: 'none',
		authResults: AAR_PASS,
	});
	const message = await sealHop(first, {
		domain: 'relay.example',
		selector: 'arc2',
		privateKey: hop2.privateKey,
		instance: 2,
		cv: 'pass',
		authResults: 'relay.example; arc=pass; dmarc=pass header.from=author.example',
	});
	return { message, resolver: resolverFor(keys) };
}

/** Assert our chain-validation state equals the `mailauth` oracle's. */
async function assertAgree(
	message: Buffer,
	resolver: ArcTestResolver,
	expected: 'pass' | 'fail' | 'none'
): Promise<void> {
	const oracle = await mailauthArcCv(message, resolver);
	const ours = await verifyArc(message, { resolver });
	expect(oracle).toBe(expected);
	expect(ours.cv).toBe(expected);
}

describe('verifyArc differential vs mailauth (RSA)', () => {
	it('valid 1-hop chain -> pass on BOTH, with honest sealer + attestation', async () => {
		const { message, resolver } = await oneHop();
		await assertAgree(message, resolver, 'pass');
		const ours = await verifyArc(message, { resolver });
		expect(ours.sealerDomain).toBe('lists.sourceforge.net');
		expect(ours.attestsOriginalPass).toBe(true);
	});

	it('valid 2-hop chain -> pass on BOTH, naming the OUTERMOST sealer', async () => {
		const { message, resolver } = await twoHop();
		await assertAgree(message, resolver, 'pass');
		const ours = await verifyArc(message, { resolver });
		expect(ours.sealerDomain).toBe('relay.example');
		expect(ours.attestsOriginalPass).toBe(true);
	});

	it('Microsoft-style transport refold of a signed header -> pass on BOTH', async () => {
		const { message, resolver } = await twoHop();
		// A downstream MTA re-folds the Subject header; relaxed canonicalization
		// unfolds it, so both the AMS and the seal chain still validate.
		const refolded = Buffer.from(
			message
				.toString('latin1')
				.replace(
					'Subject: [list] hello from the mailing list',
					'Subject: [list] hello\r\n from the mailing list'
				),
			'latin1'
		);
		await assertAgree(refolded, resolver, 'pass');
	});

	it('broken AMS body hash (mutated body) -> fail on BOTH', async () => {
		const { message, resolver } = await oneHop();
		const mutated = Buffer.from(
			message.toString('latin1').replace('This is a mailing-list', 'Xhis is a mailing-list'),
			'latin1'
		);
		await assertAgree(mutated, resolver, 'fail');
		expect((await verifyArc(mutated, { resolver })).attestsOriginalPass).toBe(false);
	});

	it('tampered outer ARC-Seal signature -> fail on BOTH', async () => {
		const { message, resolver } = await oneHop();
		await assertAgree(corruptSignature(message, 'ARC-Seal'), resolver, 'fail');
	});

	it('cv=fail on the outer seal -> fail on BOTH', async () => {
		const { message, resolver } = await twoHop();
		const cvFail = Buffer.from(message.toString('latin1').replace('cv=pass', 'cv=fail'), 'latin1');
		await assertAgree(cvFail, resolver, 'fail');
	});

	it('chain extended after a broken INNER seal -> fail on BOTH (no rescue)', async () => {
		const { message, resolver } = await twoHop();
		// Corrupt the i=1 (inner) seal; the outer i=2 seal is intact but the chain
		// is broken beneath it — a later hop must not be able to rescue it.
		const text = message.toString('latin1');
		const innerIdx = text.lastIndexOf('ARC-Seal:');
		const bIdx = text.indexOf('b=', innerIdx);
		const at = bIdx + 2;
		const ch = text[at] ?? 'A';
		const tampered = Buffer.from(
			text.slice(0, at) + (ch === 'A' ? 'B' : 'A') + text.slice(at + 1),
			'latin1'
		);
		await assertAgree(tampered, resolver, 'fail');
	});
});

describe('verifyArc — Ed25519 seal (signer→verifier round trip)', () => {
	it('a conformant Ed25519 seal over a valid RSA AMS -> pass', async () => {
		const rsa = makeRsaKey();
		const ed = makeEd25519Key();
		const rsaSealed = await sealHop(BASE_MESSAGE, {
			domain: 'lists.sourceforge.net',
			selector: 'arc1',
			privateKey: rsa.privateKey,
			instance: 1,
			cv: 'none',
			authResults: AAR_PASS,
		});
		const message = mintEd25519Seal({
			sealerDomain: 'ed-forwarder.example',
			sealerSelector: 'edsel',
			edPrivateKey: ed.privateKey,
			rsaSealed,
		});
		const resolver = resolverFor({
			'arc1._domainkey.lists.sourceforge.net': rsa.txt,
			'edsel._domainkey.ed-forwarder.example': ed.txt,
		});
		const verdict = await verifyArc(message, { resolver });
		expect(verdict.cv).toBe('pass');
		expect(verdict.sealerDomain).toBe('ed-forwarder.example');
		expect(verdict.attestsOriginalPass).toBe(true);
	});

	it('a tampered Ed25519 seal signature -> fail', async () => {
		const rsa = makeRsaKey();
		const ed = makeEd25519Key();
		const rsaSealed = await sealHop(BASE_MESSAGE, {
			domain: 'lists.sourceforge.net',
			selector: 'arc1',
			privateKey: rsa.privateKey,
			instance: 1,
			cv: 'none',
			authResults: AAR_PASS,
		});
		const message = mintEd25519Seal({
			sealerDomain: 'ed-forwarder.example',
			sealerSelector: 'edsel',
			edPrivateKey: ed.privateKey,
			rsaSealed,
		});
		const resolver = resolverFor({
			'arc1._domainkey.lists.sourceforge.net': rsa.txt,
			'edsel._domainkey.ed-forwarder.example': ed.txt,
		});
		expect((await verifyArc(corruptSignature(message, 'ARC-Seal'), { resolver })).cv).toBe('fail');
	});
});
