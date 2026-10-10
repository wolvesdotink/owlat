import { describe, expect, it } from 'vitest';
import {
	isDetachedSignatureAttachment,
	resolveSignedBodyView,
	signedBodyScopeOf,
	type SignedBodyInput,
} from '../signedScope';

const BLOCK = [
	'-----BEGIN PGP SIGNED MESSAGE-----',
	'Hash: SHA256',
	'',
	'- -- signed line',
	'Please pay invoice 2231 by Friday.',
	'-----BEGIN PGP SIGNATURE-----',
	'',
	'iQEzBAEBCAAdFiEE=',
	'-----END PGP SIGNATURE-----',
].join('\n');

const loaded = (text: string | null) => ({ state: 'loaded' as const, text });

const view = (input: Partial<SignedBodyInput>) =>
	resolveSignedBodyView({
		secureClass: 'none',
		scope: 'clearsigned',
		text: loaded(BLOCK),
		hasOtherParts: false,
		...input,
	});

describe('resolveSignedBodyView (shared scope rules)', () => {
	it('keeps only the dash-unescaped signed block', () => {
		expect(view({})).toEqual({
			kind: 'signed',
			text: '-- signed line\nPlease pay invoice 2231 by Friday.',
			omitsContent: false,
		});
	});

	it('leaves an unsigned trailer out of the signed text and says so', () => {
		const trailer = `${BLOCK}\n\nAlso, wire the deposit to the new account today.`;
		const result = view({ text: loaded(trailer) });
		expect(result).toMatchObject({ kind: 'signed', omitsContent: true });
		expect(result.kind === 'signed' && result.text).not.toContain('wire the deposit');
	});

	it('leaves an unsigned preamble out too, with CRLF line ends', () => {
		const crlf = `Note from the gateway\r\n${BLOCK.replace(/\n/g, '\r\n')}`;
		const result = view({ text: loaded(crlf) });
		expect(result).toMatchObject({ kind: 'signed', omitsContent: true });
		expect(result.kind === 'signed' && result.text).not.toContain('gateway');
	});

	it('treats an HTML alternative or attachment as content outside the signature', () => {
		expect(view({ hasOtherParts: true })).toMatchObject({ kind: 'signed', omitsContent: true });
	});

	it('withholds a clearsigned verdict when the text holds no block of its own', () => {
		expect(view({ text: loaded('plain text') })).toEqual({ kind: 'withheld' });
		expect(view({ text: loaded(null) })).toEqual({ kind: 'withheld' });
		expect(view({ text: { state: 'failed' } })).toEqual({ kind: 'withheld' });
		expect(view({ text: loaded(BLOCK.replace(/^/gm, '> ')) })).toEqual({ kind: 'withheld' });
	});

	it('waits for the text before deciding a clearsigned verdict', () => {
		expect(view({ text: { state: 'loading' } })).toEqual({ kind: 'loading' });
	});

	it('passes a MIME verdict and unsigned mail through', () => {
		expect(view({ scope: 'mime', text: { state: 'loading' } })).toEqual({ kind: 'passthrough' });
		expect(view({ scope: null, text: loaded('hello') })).toEqual({ kind: 'passthrough' });
		expect(view({ scope: null, secureClass: 'pgp-clearsigned' })).toMatchObject({
			kind: 'signed',
		});
	});
});

describe('signedBodyScopeOf (shared)', () => {
	it('reads only a recorded scope', () => {
		expect(signedBodyScopeOf(undefined)).toBeNull();
		expect(signedBodyScopeOf({ isSigned: false, scope: 'mime' })).toBeNull();
		expect(signedBodyScopeOf({ isSigned: true })).toBeNull();
		expect(signedBodyScopeOf({ isSigned: true, scope: 'clearsigned' })).toBe('clearsigned');
	});
});

describe('isDetachedSignatureAttachment (shared)', () => {
	it('matches the media type exactly', () => {
		expect(isDetachedSignatureAttachment({ contentType: 'application/pgp-signature' })).toBe(true);
		expect(isDetachedSignatureAttachment({ contentType: 'APPLICATION/PGP-SIGNATURE; x=y' })).toBe(
			true
		);
		expect(isDetachedSignatureAttachment({ contentType: 'application/pgp-keys' })).toBe(false);
	});
});
