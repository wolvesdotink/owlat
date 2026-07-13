/**
 * Offline generator for the ARC interop fixtures (Sealed Mail A5).
 *
 * Run ONCE, offline, to (re)produce the committed `*.eml` byte fixtures + the
 * `keys.json` DNS manifest the hermetic `inboundArc.test.ts` resolver serves.
 * CI never runs this — it consumes the checked-in bytes. Regenerate with:
 *
 *   node fixtures/sealed-mail/arc/generate.mjs
 *
 * (run from the repo root, so `mailauth` resolves from the root node_modules).
 *
 * We synthesize each scenario by ARC-sealing a base message as a forwarder,
 * then — for the negative cases — tampering specific bytes so the chain no
 * longer validates. Keys are freshly generated here; their public halves are
 * written to `keys.json` keyed by `<selector>._domainkey.<domain>` exactly as
 * the DKIM/ARC key lookup asks for them.
 */

import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sealMessage } from 'mailauth/lib/arc/index.js';

const outDir = dirname(fileURLToPath(import.meta.url));
const SELECTOR = 'arc1';

/** One RSA keypair per sealer domain; public half → keys.json TXT record. */
function makeKey() {
	const { publicKey, privateKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});
	const p = publicKey
		.replace(/-----BEGIN PUBLIC KEY-----/, '')
		.replace(/-----END PUBLIC KEY-----/, '')
		.replace(/\s+/g, '');
	return { privateKey, txt: `v=DKIM1; k=rsa; p=${p}` };
}

/** A minimal base message from the original author (no author DKIM — DMARC is
 *  supplied separately at delivery; here we only care about the ARC layer). */
function baseMessage() {
	return Buffer.from(
		[
			'From: Alice Author <alice@author.example>',
			'To: list@lists.example',
			'Subject: [list] hello from the mailing list',
			'Date: Tue, 01 Jul 2025 12:00:00 +0000',
			'Message-ID: <arc-fixture-001@author.example>',
			'MIME-Version: 1.0',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'This is a mailing-list message whose author DKIM was broken by the list.',
			'',
		].join('\r\n'),
	);
}

/** Seal `base` as `sealerDomain`, attesting the original passed DMARC. */
async function seal(sealerDomain, key) {
	const base = baseMessage();
	const arcHeaders = await sealMessage(base, {
		signingDomain: sealerDomain,
		selector: SELECTOR,
		privateKey: key.privateKey,
		algorithm: 'rsa-sha256',
		cv: 'none', // i=1: no prior chain
		i: 1,
		authResults:
			`${sealerDomain}; dmarc=pass header.from=author.example; ` +
			`spf=pass smtp.mailfrom=lists.example; dkim=pass header.d=author.example`,
	});
	return Buffer.concat([arcHeaders, base]);
}

const keys = {};

// a. Valid rescue chain — sealer is a well-known forwarder (also in the seeded
//    trusted list, so the convex-test can assert the override fires).
const trustedKey = makeKey();
keys[`${SELECTOR}._domainkey.lists.sourceforge.net`] = trustedKey.txt;
const valid = await seal('lists.sourceforge.net', trustedKey);
writeFileSync(join(outDir, 'valid-rescue.eml'), valid);

// b. Broken AMS — flip a byte in the message body so the ARC-Message-Signature
//    body hash no longer matches ⇒ chain fails.
const brokenAms = Buffer.from(valid);
const bodyMarker = brokenAms.indexOf('This is a mailing-list');
brokenAms[bodyMarker] = 'X'.charCodeAt(0); // 'T' -> 'X'
writeFileSync(join(outDir, 'broken-ams.eml'), brokenAms);

// c. Untrusted sealer — a valid chain, but sealed by a domain NOT on the
//    trusted-forwarder list. Verdict is cv=pass with that sealer domain.
const untrustedKey = makeKey();
keys[`${SELECTOR}._domainkey.evil-forwarder.example`] = untrustedKey.txt;
const untrusted = await seal('evil-forwarder.example', untrustedKey);
writeFileSync(join(outDir, 'untrusted-sealer.eml'), untrusted);

// d. cv=fail — corrupt the ARC-Seal signature (`b=` of the ARC-Seal header) so
//    the seal chain itself fails to validate.
let cvFail = valid.toString('binary');
cvFail = cvFail.replace(/(ARC-Seal:[\s\S]*?b=)([A-Za-z0-9+/=]{10})/, (_m, p1, p2) => {
	// rotate the first 10 base64 chars of the seal signature
	const rotated = p2.split('').reverse().join('');
	return p1 + rotated;
});
writeFileSync(join(outDir, 'cv-fail.eml'), Buffer.from(cvFail, 'binary'));

writeFileSync(join(outDir, 'keys.json'), JSON.stringify(keys, null, 2) + '\n');

console.log('ARC fixtures written to', outDir);
