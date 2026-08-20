import { describe, expect, it } from 'vitest';
import {
	checkDkimEvidenceAdmissibility,
	MIN_RSA_KEY_BITS,
	REQUIRED_SIGNED_HEADERS,
	type DkimEvidenceInput,
	type DkimInadmissibilityReason,
} from '../dkimEvidence.js';

/** A signature that clears every admissibility rule of plan §7.1. */
const ADMISSIBLE: DkimEvidenceInput = {
	algorithm: 'rsa-sha256',
	keyBits: 2048,
	usesBodyLengthTag: false,
	signedHeaderNames: ['from', 'to', 'subject', 'date', 'message-id'],
};

const check = (patch: Partial<DkimEvidenceInput>) =>
	checkDkimEvidenceAdmissibility({ ...ADMISSIBLE, ...patch });

describe('admissible signatures', () => {
	it.each([
		['rsa-sha256 at the floor', { algorithm: 'rsa-sha256', keyBits: MIN_RSA_KEY_BITS }],
		['rsa-sha256 well above the floor', { algorithm: 'rsa-sha256', keyBits: 4096 }],
		['ed25519-sha256 with no key size stated', { algorithm: 'ed25519-sha256', keyBits: undefined }],
		['an uppercase algorithm', { algorithm: 'RSA-SHA256' }],
		['a padded algorithm', { algorithm: '  rsa-sha256 ' }],
		['mixed-case header names', { signedHeaderNames: ['From', 'DATE', 'Message-ID'] }],
		['padded header names', { signedHeaderNames: [' from ', 'date', 'message-id '] }],
		['oversigned headers', { signedHeaderNames: ['from', 'from', 'date', 'message-id'] }],
	])('admits %s', (_label, patch) => {
		expect(check(patch)).toEqual({ admissible: true, reasons: [] });
	});
});

describe('the inadmissibility rules', () => {
	const table: Array<[string, Partial<DkimEvidenceInput>, DkimInadmissibilityReason[]]> = [
		['an l= body-length tag', { usesBodyLengthTag: true }, ['body-length-tag']],
		['an RSA key below the floor', { keyBits: MIN_RSA_KEY_BITS - 1 }, ['weak-rsa-key']],
		['a 1024-bit RSA key', { keyBits: 1024 }, ['weak-rsa-key']],
		['an RSA key of unstated size', { keyBits: undefined }, ['unknown-rsa-key-size']],
		['an RSA key of zero size', { keyBits: 0 }, ['unknown-rsa-key-size']],
		[
			'an RSA key size that is not a number',
			{ keyBits: '2048' as unknown as number },
			['unknown-rsa-key-size'],
		],
		['an unsigned From', { signedHeaderNames: ['date', 'message-id'] }, ['unsigned-from']],
		['an unsigned Date', { signedHeaderNames: ['from', 'message-id'] }, ['unsigned-date']],
		['an unsigned Message-ID', { signedHeaderNames: ['from', 'date'] }, ['unsigned-message-id']],
		[
			'an empty h= list',
			{ signedHeaderNames: [] },
			['unsigned-from', 'unsigned-date', 'unsigned-message-id'],
		],
		['a sha1 signature', { algorithm: 'rsa-sha1' }, ['weak-hash']],
		['an unknown algorithm', { algorithm: 'dsa-sha256' }, ['unsupported-algorithm']],
		['a missing algorithm', { algorithm: '' }, ['unsupported-algorithm']],
		['a malformed algorithm', { algorithm: 'rsa-sha256-pss' }, ['unsupported-algorithm']],
	];

	it.each(table)('rejects %s', (_label, patch, reasons) => {
		expect(check(patch)).toEqual({ admissible: false, reasons });
	});

	it('accumulates every reason in a fixed order', () => {
		expect(
			check({
				usesBodyLengthTag: true,
				algorithm: 'rsa-sha1',
				keyBits: 512,
				signedHeaderNames: ['subject'],
			})
		).toEqual({
			admissible: false,
			reasons: [
				'body-length-tag',
				'weak-hash',
				'weak-rsa-key',
				'unsigned-from',
				'unsigned-date',
				'unsigned-message-id',
			],
		});
	});

	it('does not ask an ed25519 signature for a key size', () => {
		expect(check({ algorithm: 'ed25519-sha256', keyBits: 256 }).admissible).toBe(true);
		expect(check({ algorithm: 'ed25519-sha256', keyBits: undefined }).admissible).toBe(true);
	});

	it('names all three required headers', () => {
		expect([...REQUIRED_SIGNED_HEADERS]).toEqual(['from', 'date', 'message-id']);
	});
});

describe('hostile input', () => {
	it('answers rather than throwing for non-array header lists', () => {
		const result = checkDkimEvidenceAdmissibility({
			...ADMISSIBLE,
			signedHeaderNames: 'from:date:message-id' as unknown as string[],
		});
		expect(result.reasons).toEqual(['unsigned-from', 'unsigned-date', 'unsigned-message-id']);
	});

	it('ignores non-string entries in the header list', () => {
		expect(
			checkDkimEvidenceAdmissibility({
				...ADMISSIBLE,
				signedHeaderNames: [null as unknown as string, 'from', 'date', 'message-id'],
			}).admissible
		).toBe(true);
	});

	it.each([
		['undefined', undefined],
		['zero', 0],
		['the empty string', ''],
		['null', null],
		['the string "false"', 'false'],
	])('treats a %p body-length flag as present rather than absent', (_label, usesBodyLengthTag) => {
		// Only an explicit `false` establishes that `l=` was absent; a parser
		// yielding anything else must not be the thing that admits evidence.
		expect(check({ usesBodyLengthTag: usesBodyLengthTag as unknown as boolean }).reasons).toContain(
			'body-length-tag'
		);
	});

	it('answers rather than throwing for a non-string algorithm', () => {
		expect(check({ algorithm: null as unknown as string }).reasons).toEqual([
			'unsupported-algorithm',
		]);
	});

	it.each([
		['NaN', Number.NaN],
		['Infinity', Number.POSITIVE_INFINITY],
		['fractional', 2048.5],
		['negative', -4096],
	])('treats a %s key size as unproven rather than as clearing the floor', (_label, keyBits) => {
		expect(check({ keyBits }).reasons).toEqual(['unknown-rsa-key-size']);
	});
});
