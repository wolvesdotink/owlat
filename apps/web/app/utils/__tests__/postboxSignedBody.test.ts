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

type Input = Parameters<typeof resolveSignedBodyView>[0];
const loaded = (text: string | null) => ({ state: 'loaded' as const, text });
const LOADING = { state: 'loading' as const };
const FAILED = { state: 'failed' as const };

const view = (input: Partial<Input>) =>
	resolveSignedBodyView({
		secureClass: 'none',
		scope: 'clearsigned',
		text: loaded(BLOCK),
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
		expect(view({ text: loaded(`Intro\n${BLOCK}`) })).toMatchObject({ omitsContent: true });
		expect(view({ text: loaded(`${BLOCK}\r\n\r\nFooter`) })).toMatchObject({ omitsContent: true });
		expect(view({ text: loaded(`\n${BLOCK}\n\n  \n`) })).toMatchObject({ omitsContent: false });
		expect(view({ hasHtml: true })).toMatchObject({ omitsContent: true });
	});

	it('keeps a whitespace-only block, which can still verify, as a signed view', () => {
		const blank = BLOCK.replace('- -- signed line\nsecond line', '   ');
		expect(view({ text: loaded(blank), hasHtml: true })).toEqual({
			kind: 'signed',
			text: '',
			omitsContent: true,
		});
	});

	it('is loading while a clearsigned verdict waits for its text', () => {
		expect(view({ text: LOADING })).toEqual({ kind: 'loading' });
	});

	it('withholds a clearsigned verdict the text holds no block for', () => {
		expect(view({ text: loaded('plain text') })).toEqual({ kind: 'withheld' });
		expect(view({ text: loaded(null) })).toEqual({ kind: 'withheld' });
		expect(view({ text: FAILED })).toEqual({ kind: 'withheld' });
		// A quoted block is not this message's own.
		expect(view({ text: loaded(BLOCK.replace(/^/gm, '> ')) })).toEqual({ kind: 'withheld' });
	});

	it('reads the scope, not the attachment list', () => {
		// An unrelated .asc attachment makes the host say pgp-signed.
		expect(view({ secureClass: 'pgp-signed' })).toMatchObject({ kind: 'signed' });
		// A nameless MIME signature part leaves the host saying none.
		expect(view({ scope: 'mime', text: LOADING })).toEqual({ kind: 'passthrough' });
	});

	it('passes mail without a verdict through, except an inline clearsigned block', () => {
		expect(view({ scope: null, text: LOADING })).toEqual({ kind: 'passthrough' });
		expect(view({ scope: null, secureClass: 'pgp-signed' })).toEqual({ kind: 'passthrough' });
		expect(view({ scope: null, secureClass: 'pgp-clearsigned' })).toMatchObject({
			kind: 'signed',
		});
	});

	describe('rows verified before the scope was recorded', () => {
		const legacy = (input: Partial<Input>) => view({ scope: 'unrecorded', ...input });

		it('show the verdict only beside a clearsigned block in text that loaded', () => {
			expect(legacy({})).toMatchObject({ kind: 'signed' });
			expect(legacy({ text: LOADING })).toEqual({ kind: 'loading' });
		});

		it('withhold it on a failed load, a text without a block, and no text', () => {
			expect(legacy({ text: FAILED })).toEqual({ kind: 'withheld' });
			expect(legacy({ text: loaded('signed text') })).toEqual({ kind: 'withheld' });
			expect(legacy({ text: loaded(null) })).toEqual({ kind: 'withheld' });
		});

		it('withhold it under a .asc attachment or MIME structure, block or not', () => {
			for (const secureClass of ['pgp-signed', 'pgp-encrypted', 'smime-signed'] as const) {
				expect(legacy({ secureClass })).toEqual({ kind: 'withheld' });
				expect(legacy({ secureClass, text: loaded('signed text') })).toEqual({ kind: 'withheld' });
				expect(legacy({ secureClass, text: LOADING })).toEqual({ kind: 'withheld' });
			}
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
