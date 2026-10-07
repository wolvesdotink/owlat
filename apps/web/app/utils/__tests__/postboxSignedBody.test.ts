import { describe, expect, it } from 'vitest';
import { isTextPartSignature, resolveSignedBodyView } from '../postboxSignedBody';

const BLOCK = [
	'-----BEGIN PGP SIGNED MESSAGE-----',
	'Hash: SHA256',
	'',
	'- -- signed line',
	'second line',
	'-----BEGIN PGP SIGNATURE-----',
	'',
	'iQEzBAEBCAAdFiEE=',
	'-----END PGP SIGNATURE-----',
].join('\n');

const view = (input: Partial<Parameters<typeof resolveSignedBodyView>[0]>) =>
	resolveSignedBodyView({
		secureClass: 'none',
		hasVerdict: true,
		text: BLOCK,
		hasHtml: false,
		...input,
	});

describe('resolveSignedBodyView', () => {
	it('shows the dash-unescaped signed block, via the shared extractor', () => {
		expect(view({})).toEqual({
			kind: 'signed',
			text: '-- signed line\nsecond line',
			omitsContent: false,
		});
	});

	it('flags text outside the block and an HTML alternative as left out', () => {
		expect(view({ text: `Intro\n${BLOCK}` })).toMatchObject({ omitsContent: true });
		expect(view({ text: `${BLOCK}\r\n\r\nFooter` })).toMatchObject({ omitsContent: true });
		expect(view({ text: `\n${BLOCK}\n\n  \n` })).toMatchObject({ omitsContent: false });
		expect(view({ hasHtml: true })).toMatchObject({ omitsContent: true });
	});

	it('is loading while a text-part verdict waits for its text', () => {
		expect(view({ text: undefined })).toEqual({ kind: 'loading' });
	});

	it('drops a verdict the text holds no signed block for', () => {
		expect(view({ text: 'plain text' })).toEqual({ kind: 'unbound' });
		expect(view({ text: null })).toEqual({ kind: 'unbound' });
		// A quoted block is not this message's own.
		expect(view({ text: BLOCK.replace(/^/gm, '> ') })).toEqual({ kind: 'unbound' });
	});

	it('passes MIME-structured and unsigned mail through', () => {
		expect(view({ secureClass: 'pgp-signed', text: undefined })).toEqual({ kind: 'passthrough' });
		expect(view({ secureClass: 'smime-signed' })).toEqual({ kind: 'passthrough' });
		expect(view({ secureClass: 'pgp-encrypted' })).toEqual({ kind: 'passthrough' });
		expect(view({ hasVerdict: false, text: undefined })).toEqual({ kind: 'passthrough' });
	});

	it('keeps an unverified inline clearsigned body on its signed block', () => {
		expect(view({ secureClass: 'pgp-clearsigned', hasVerdict: false })).toMatchObject({
			kind: 'signed',
		});
	});

	it('names which classes carry a text-part verdict', () => {
		expect(isTextPartSignature('none')).toBe(true);
		expect(isTextPartSignature('pgp-clearsigned')).toBe(true);
		expect(isTextPartSignature('pgp-signed')).toBe(false);
	});
});
