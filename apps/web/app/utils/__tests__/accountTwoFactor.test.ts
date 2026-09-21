import { describe, expect, it } from 'vitest';
import {
	backupCodesFilename,
	buildBackupCodesFile,
	groupSecret,
	isCompleteTotpCode,
	normalizeTotpCode,
	parseTotpUri,
	totpQrCode,
} from '~/utils/accountTwoFactor';

// The exact shape BetterAuth's `two-factor/enable` returns: `Issuer:account` in
// the label, the issuer repeated as a query parameter.
const URI = 'otpauth://totp/Owlat:ada%40northwind.studio?secret=JBSWY3DPEHPK3PXP&issuer=Owlat';

describe('parseTotpUri', () => {
	it('reads the secret, issuer and account out of the enrolment URI', () => {
		expect(parseTotpUri(URI)).toEqual({
			secret: 'JBSWY3DPEHPK3PXP',
			issuer: 'Owlat',
			account: 'ada@northwind.studio',
		});
	});

	it('falls back to the label issuer when the query parameter is absent', () => {
		expect(parseTotpUri('otpauth://totp/Owlat:ada@northwind.studio?secret=ABCD')?.issuer).toBe(
			'Owlat'
		);
	});

	it('treats an unqualified label as the account', () => {
		expect(parseTotpUri('otpauth://totp/ada@northwind.studio?secret=ABCD')).toEqual({
			secret: 'ABCD',
			issuer: null,
			account: 'ada@northwind.studio',
		});
	});

	/**
	 * The caller renders a QR AND a manual key off one parse, so a URI that
	 * yields no secret has to fail as a whole — otherwise the page paints a QR
	 * for a secret its manual-entry field cannot show.
	 */
	it.each([
		[null],
		[undefined],
		[''],
		['not a uri'],
		['https://example.test/?secret=ABCD'],
		['otpauth://hotp/Owlat:ada?secret=ABCD'],
		['otpauth://totp/Owlat:ada'],
		['otpauth://totp/Owlat:ada?secret='],
	])('rejects %p', (uri) => {
		expect(parseTotpUri(uri)).toBeNull();
	});
});

describe('groupSecret', () => {
	it('breaks the secret into typeable groups of four', () => {
		expect(groupSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
	});

	it('normalises whatever spacing and case it is handed', () => {
		expect(groupSecret(' jbswy3dp ehpk3pxp ')).toBe('JBSW Y3DP EHPK 3PXP');
	});

	it('leaves a short trailing group short rather than padding it', () => {
		expect(groupSecret('ABCDE')).toBe('ABCD E');
	});

	it('produces nothing from nothing', () => {
		expect(groupSecret('')).toBe('');
	});
});

describe('totpQrCode', () => {
	const qr = totpQrCode(URI);

	it('encodes to a square matrix with a quiet border', () => {
		// Version 1 is 21 modules; +1 border on each side. Anything smaller than
		// the smallest QR means the encoder was handed nothing.
		expect(qr.size).toBeGreaterThanOrEqual(23);
		expect(qr.size % 2).toBe(1);
	});

	it('emits path data, not markup', () => {
		expect(qr.path).toMatch(/^M[\d\s]/);
		expect(qr.path).not.toContain('<');
	});

	/**
	 * Runs are merged horizontally — that is what keeps the whole code in one DOM
	 * node. A finder pattern is 7 modules wide, so at least one sub-path must
	 * cover several modules; a per-module path would only ever emit `h1`.
	 */
	it('merges horizontal runs instead of emitting one rect per module', () => {
		expect(qr.path).toMatch(/h[2-9]\d*v1/);
	});

	it('is deterministic for the same URI', () => {
		expect(totpQrCode(URI)).toEqual(qr);
	});

	it('encodes different URIs differently', () => {
		expect(totpQrCode('otpauth://totp/Owlat:other?secret=ZZZZ').path).not.toBe(qr.path);
	});
});

describe('normalizeTotpCode / isCompleteTotpCode', () => {
	it('keeps only digits, so a pasted "123 456" submits', () => {
		expect(normalizeTotpCode('123 456')).toBe('123456');
		expect(normalizeTotpCode('12-34-56')).toBe('123456');
	});

	it('caps at six digits so a stray keystroke cannot overrun the field', () => {
		expect(normalizeTotpCode('1234567890')).toBe('123456');
	});

	it('is complete at exactly six digits', () => {
		expect(isCompleteTotpCode('123456')).toBe(true);
		expect(isCompleteTotpCode('12345')).toBe(false);
		expect(isCompleteTotpCode('1234567')).toBe(false);
		expect(isCompleteTotpCode('12345a')).toBe(false);
		expect(isCompleteTotpCode('')).toBe(false);
	});
});

describe('buildBackupCodesFile', () => {
	const file = buildBackupCodesFile({
		codes: ['aaaa-bbbb', 'cccc-dddd'],
		heading: 'Owlat backup codes',
		accountLine: 'Account: ada@northwind.studio',
		issuedLine: 'Issued: 27 August 2026',
		notes: ['Each code works once.', 'Keep this file somewhere safe.'],
	});

	/**
	 * The file is found months later in a downloads folder with no context
	 * attached, so it has to say which account it opens and when it was issued —
	 * a bare list of ten codes is unusable at that point.
	 */
	it('names the account and the issue date alongside the codes', () => {
		expect(file).toContain('Account: ada@northwind.studio');
		expect(file).toContain('Issued: 27 August 2026');
		expect(file).toContain('Each code works once.');
	});

	it('puts every code on its own line', () => {
		const lines = file.split('\n');
		expect(lines).toContain('  aaaa-bbbb');
		expect(lines).toContain('  cccc-dddd');
	});

	it('underlines the heading to its own width', () => {
		expect(file.split('\n')[1]).toBe('='.repeat('Owlat backup codes'.length));
	});
});

describe('backupCodesFilename', () => {
	it('stamps the local calendar day, zero-padded', () => {
		expect(backupCodesFilename(new Date(2026, 0, 5))).toBe('owlat-backup-codes-2026-01-05.txt');
	});

	// Local, not UTC: the filename has to match the issue date printed inside the
	// file, which is also rendered in the reader's own timezone.
	it('uses the local day, not the UTC one', () => {
		const lateEvening = new Date(2026, 7, 27, 23, 30);
		expect(backupCodesFilename(lateEvening)).toBe('owlat-backup-codes-2026-08-27.txt');
	});
});
