import { generateKeyPairSync } from 'node:crypto';
import dns from 'node:dns/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsedDkimKeyBits, resolveDkimKey } from '../checklistDkimValidation';

function rsaDkimRecord(modulusLength = 2_048): string {
	const { publicKey } = generateKeyPairSync('rsa', { modulusLength });
	const encoded = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
	return `v=DKIM1; k=rsa; p=${encoded}`;
}

afterEach(() => vi.restoreAllMocks());

describe('parsedDkimKeyBits', () => {
	it('rejects non-canonical base64 instead of accepting a valid key with trailing junk', () => {
		expect(parsedDkimKeyBits(`${rsaDkimRecord()}!`)).toBeNull();
	});

	it('accepts omitted optional padding but rejects non-canonical padding', () => {
		const paddedRecord = rsaDkimRecord(3_072);
		expect(parsedDkimKeyBits(paddedRecord.replace(/=+$/, ''))).toBe(3_072);
		expect(parsedDkimKeyBits(`${paddedRecord}=`)).toBeNull();
	});

	it.each([
		['s=calendar; h=sha256', 'a non-email service restriction'],
		['s=email; h=sha1', 'a SHA-1-only hash restriction'],
		['s=email:', 'an empty service-list item'],
		['h=:sha256', 'an empty hash-list item'],
	])('rejects a valid RSA key with %s', (tags) => {
		expect(parsedDkimKeyBits(`${rsaDkimRecord()}; ${tags}`)).toBeNull();
	});

	it('rejects a version tag that is not first or is not case-exact', () => {
		const versionedRecord = rsaDkimRecord();
		expect(parsedDkimKeyBits(versionedRecord.replace('v=DKIM1; ', '') + '; v=DKIM1')).toBeNull();
		expect(parsedDkimKeyBits(versionedRecord.replace('v=DKIM1', 'v=dkim1'))).toBeNull();
	});

	it('treats tag names case-sensitively', () => {
		expect(
			parsedDkimKeyBits(rsaDkimRecord().replace('v=DKIM1; k=rsa; p=', 'V=DKIM1; K=RSA; P='))
		).toBeNull();
	});

	it('rejects empty tag specs while allowing one optional trailing semicolon', () => {
		const record = rsaDkimRecord().replace('; k=rsa', '');
		expect(parsedDkimKeyBits(`; ${record}`)).toBeNull();
		expect(parsedDkimKeyBits(record.replace('; p=', ';; p='))).toBeNull();
		expect(parsedDkimKeyBits(`${record};;`)).toBeNull();
		expect(parsedDkimKeyBits(`${record};`)).toBe(2_048);
		expect(parsedDkimKeyBits(`${record}; \t `)).toBe(2_048);
		expect(parsedDkimKeyBits(record.replace('; p=', '; \t ; p='))).toBeNull();
		expect(parsedDkimKeyBits(`${record}; \t ; \t `)).toBeNull();
	});

	it('accepts compatible service and hash lists', () => {
		expect(parsedDkimKeyBits(`${rsaDkimRecord()}; s=calendar:email; h=sha1:sha256`)).toBe(2_048);
		expect(parsedDkimKeyBits(`${rsaDkimRecord()}; s=*; h=sha256`)).toBe(2_048);
	});
});

describe('resolveDkimKey', () => {
	it('finds a valid key after more than eight unrelated TXT answers', async () => {
		const unrelated = Array.from({ length: 9 }, (_, index) => [`site-verification=${index}`]);
		vi.spyOn(dns, 'resolveTxt').mockResolvedValue([...unrelated, [rsaDkimRecord()]]);

		await expect(resolveDkimKey('selector.example.test')).resolves.toEqual({
			outcome: 'resolved',
			bits: 2_048,
		});
	});

	it('rejects two key candidates even when the second is beyond the eighth answer', async () => {
		const unrelated = Array.from({ length: 9 }, (_, index) => [`site-verification=${index}`]);
		vi.spyOn(dns, 'resolveTxt').mockResolvedValue([
			[rsaDkimRecord()],
			...unrelated,
			[rsaDkimRecord()],
		]);

		await expect(resolveDkimKey('selector.example.test')).resolves.toEqual({
			outcome: 'resolved',
			bits: null,
		});
	});

	it.each([
		['malformed base64', () => `${rsaDkimRecord()}!`],
		['a non-email service restriction', () => `${rsaDkimRecord()}; s=calendar; h=sha256`],
		['a SHA-1-only hash restriction', () => `${rsaDkimRecord()}; s=email; h=sha1`],
	])('rejects a CNAME target with %s', async (_description, record) => {
		vi.spyOn(dns, 'resolveTxt')
			.mockRejectedValueOnce(new Error('selector is a CNAME'))
			.mockResolvedValueOnce([[record()]]);
		vi.spyOn(dns, 'resolveCname').mockResolvedValueOnce(['provider.example.test.']);

		await expect(resolveDkimKey('selector.example.test')).resolves.toEqual({
			outcome: 'resolved',
			bits: null,
		});
	});

	it('accepts compatible service and hash tags at a CNAME target', async () => {
		vi.spyOn(dns, 'resolveTxt')
			.mockRejectedValueOnce(new Error('selector is a CNAME'))
			.mockResolvedValueOnce([[`${rsaDkimRecord()}; s=calendar:email; h=sha1:sha256`]]);
		vi.spyOn(dns, 'resolveCname').mockResolvedValueOnce(['provider.example.test.']);

		await expect(resolveDkimKey('selector.example.test')).resolves.toEqual({
			outcome: 'resolved',
			bits: 2_048,
		});
	});
});
