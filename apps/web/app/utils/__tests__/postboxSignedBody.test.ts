import { describe, expect, it } from 'vitest';
import { resolveSignedBodyView, signedBodyScopeOf } from '../postboxSignedBody';

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
		scope: 'clearsigned',
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

	it('keeps a whitespace-only block, which can still verify, as a signed view', () => {
		const blank = BLOCK.replace('- -- signed line\nsecond line', '   ');
		expect(view({ text: blank, hasHtml: true })).toEqual({
			kind: 'signed',
			text: '',
			omitsContent: true,
		});
	});

	it('is loading while a clearsigned verdict waits for its text', () => {
		expect(view({ text: undefined })).toEqual({ kind: 'loading' });
	});

	it('withholds a clearsigned verdict the text holds no block for', () => {
		expect(view({ text: 'plain text' })).toEqual({ kind: 'withheld' });
		expect(view({ text: null })).toEqual({ kind: 'withheld' });
		// A quoted block is not this message's own.
		expect(view({ text: BLOCK.replace(/^/gm, '> ') })).toEqual({ kind: 'withheld' });
	});

	it('reads the scope, not the attachment list', () => {
		// An unrelated .asc attachment makes the host say pgp-signed.
		expect(view({ secureClass: 'pgp-signed' })).toMatchObject({ kind: 'signed' });
		// A nameless MIME signature part leaves the host saying none.
		expect(view({ scope: 'mime', text: undefined })).toEqual({ kind: 'passthrough' });
	});

	it('passes mail without a verdict through, except an inline clearsigned block', () => {
		expect(view({ scope: null, text: undefined })).toEqual({ kind: 'passthrough' });
		expect(view({ scope: null, secureClass: 'pgp-signed' })).toEqual({ kind: 'passthrough' });
		expect(view({ scope: null, secureClass: 'pgp-clearsigned' })).toMatchObject({
			kind: 'signed',
		});
	});

	describe('rows verified before the scope was recorded', () => {
		const legacy = (input: Partial<Parameters<typeof resolveSignedBodyView>[0]>) =>
			view({ scope: 'unrecorded', ...input });

		it('read a .asc attachment as PGP/MIME only when the text has no block', () => {
			expect(legacy({ secureClass: 'pgp-signed', text: undefined })).toEqual({
				kind: 'loading',
			});
			expect(legacy({ secureClass: 'pgp-signed', text: 'signed text' })).toEqual({
				kind: 'passthrough',
			});
			expect(legacy({ secureClass: 'pgp-signed' })).toEqual({ kind: 'withheld' });
		});

		it('read the text body otherwise, and leave encrypted and S/MIME mail alone', () => {
			expect(legacy({})).toMatchObject({ kind: 'signed' });
			expect(legacy({ text: 'signed text' })).toEqual({ kind: 'withheld' });
			expect(legacy({ secureClass: 'pgp-encrypted' })).toEqual({ kind: 'passthrough' });
			expect(legacy({ secureClass: 'smime-signed' })).toEqual({ kind: 'passthrough' });
		});
	});
});

describe('signedBodyScopeOf', () => {
	it('names the recorded scope, or marks it unrecorded', () => {
		expect(signedBodyScopeOf(undefined)).toBeNull();
		expect(signedBodyScopeOf({ isSigned: true })).toBe('unrecorded');
		expect(signedBodyScopeOf({ isSigned: true, scope: 'mime' })).toBe('mime');
	});
});
