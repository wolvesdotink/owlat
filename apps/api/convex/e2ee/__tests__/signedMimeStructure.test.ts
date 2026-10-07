/**
 * PGP/MIME verdicts hold only when the reader's MIME walker agrees with the
 * extractor (`e2ee/signedMimeStructure.ts`, #1311). Each case signs a real
 * first part and then bends the structure around it the way a sender who
 * wants unsigned content shown beside a valid verdict would: the signature
 * still verifies over the extracted octets, so only the cross-check stands
 * between that and a "verified" record.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import { parseBody } from '@owlat/mail-message/parse/body';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { generateTestKeypair, modules, seedPinnedSender } from './sealedMailTestHelpers';
import {
	composeSignedPgpMime,
	detachedSign,
	nestedAlternativeFirstPart,
	signedFirstPart,
} from './signedMailTestHelpers';
import { signedPartIsDisplayedBody } from '../signedMimeStructure';
import { extractRfc3156SignedPart } from '@owlat/mail-canon';

const SENDER = 'alice@sender.test';
const BOUNDARY = 'owlat-f1-signed';
const CLOSE = `--${BOUNDARY}--`;
const UNSIGNED = '<p>UNSIGNED_APPENDED_HTML</p>';

async function setup(firstPart = signedFirstPart('Signed content.')) {
	const t = convexTest(schema, modules);
	const sender = await generateTestKeypair(SENDER);
	await seedPinnedSender(t, {
		address: SENDER,
		domain: 'sender.test',
		pinnedPublicKeyArmored: sender.publicKeyArmored,
	});
	const raw = composeSignedPgpMime({
		from: SENDER,
		to: 'me@example.com',
		subject: 'signed message',
		part: firstPart,
		signatureArmored: await detachedSign(firstPart, sender.privateKeyArmored),
		messageId: '<signed-1311@sender.test>',
		boundary: BOUNDARY,
	});
	return { t, sender, raw };
}

async function verdict(t: Awaited<ReturnType<typeof setup>>['t'], raw: string) {
	const result = await t.action(internal.e2ee.verifyInboundSignature.forInbound, {
		rawBytesBase64: Buffer.from(raw, 'latin1').toString('base64'),
		from: SENDER,
	});
	return result.isSigned ? result.info : null;
}

const MALFORMED = {
	isSigned: true,
	isSignatureValid: false,
	keySource: 'pinned',
	failure: 'malformed_signature',
	scope: 'mime',
};

describe('PGP/MIME: the reader must show only what was signed (#1311)', () => {
	it('a well-formed message with a nested alternative first part still verifies', async () => {
		const { t, sender, raw } = await setup(nestedAlternativeFirstPart('Signed content.'));
		expect(await verdict(t, raw)).toEqual({
			isSigned: true,
			isSignatureValid: true,
			signerFingerprint: sender.fingerprint,
			keySource: 'pinned',
			scope: 'mime',
		});
		expect(parseBody(raw).html).toBe('<p>Signed content.</p>');
	});

	it('a junk-suffixed close delimiter followed by a third part is malformed', async () => {
		const { t, raw } = await setup();
		const bent = raw.replace(
			CLOSE,
			[`${CLOSE}extra`, `--${BOUNDARY}`, 'Content-Type: text/html', '', UNSIGNED, CLOSE].join(
				'\r\n'
			)
		);
		// The reader's parser shows the appended part.
		expect(parseBody(bent).html).toContain('UNSIGNED_APPENDED_HTML');
		expect(await verdict(t, bent)).toEqual(MALFORMED);
	});

	it('a third part opened by a bare-LF delimiter is malformed', async () => {
		const { t, raw } = await setup();
		const bent = raw.replace(
			`\r\n${CLOSE}`,
			`\n--${BOUNDARY}\r\nContent-Type: text/html\r\n\r\n${UNSIGNED}\r\n${CLOSE}`
		);
		expect(parseBody(bent).html).toContain('UNSIGNED_APPENDED_HTML');
		// The extractor alone still accepts it: the cross-check is what refuses.
		const parts = extractRfc3156SignedPart(Buffer.from(bent, 'latin1'));
		expect(parts).not.toBeNull();
		expect(signedPartIsDisplayedBody(Buffer.from(bent, 'latin1'), parts!.signedPart)).toBe(false);
		expect(await verdict(t, bent)).toEqual(MALFORMED);
	});

	it('a signature part with a second Content-Type is malformed', async () => {
		const { t, raw } = await setup();
		const bent = raw.replace(
			'Content-Type: application/pgp-signature; name="signature.asc"',
			'Content-Type: application/pgp-signature; name="signature.asc"\r\nContent-Type: text/html'
		);
		// The reader takes the last Content-Type and renders the part as HTML.
		expect(parseBody(bent).html).toContain('BEGIN PGP SIGNATURE');
		expect(await verdict(t, bent)).toEqual(MALFORMED);
	});

	it('a first part with a second Content-Type is malformed', async () => {
		const { t, raw } = await setup(
			['Content-Type: text/plain', 'Content-Type: text/html', '', UNSIGNED].join('\r\n')
		);
		expect(await verdict(t, raw)).toEqual(MALFORMED);
	});
});
