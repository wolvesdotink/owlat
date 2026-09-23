import { describe, expect, it } from 'vitest';
import {
	adminDisplayNames,
	decodeAudienceValue,
	encodeAudienceValue,
	joinList,
	missingSetupItems,
} from '~/utils/campaignSetupReadiness';

describe('missingSetupItems', () => {
	it('lists what is missing in form order', () => {
		expect(missingSetupItems({ hasName: false, senderReady: false, hasRecipients: false })).toEqual(
			['name', 'sender', 'recipients']
		);
	});

	it('is empty once everything is in place', () => {
		expect(missingSetupItems({ hasName: true, senderReady: true, hasRecipients: true })).toEqual(
			[]
		);
	});

	it('only names the parts still missing', () => {
		expect(missingSetupItems({ hasName: true, senderReady: false, hasRecipients: true })).toEqual([
			'sender',
		]);
	});
});

describe('joinList', () => {
	it('joins with the locale conjunction', () => {
		expect(joinList(['a sender', 'recipients'], 'en')).toBe('a sender and recipients');
		expect(joinList(['ein Absender', 'Empfänger'], 'de')).toBe('ein Absender und Empfänger');
	});
});

describe('adminDisplayNames', () => {
	const member = (role: string, name: string | null, email: string) => ({
		role,
		user: { name, email },
	});

	it('names owners before admins and skips editors', () => {
		expect(
			adminDisplayNames(
				[
					member('admin', 'Ben Ito', 'ben@example.com'),
					member('editor', 'Eve', 'eve@example.com'),
					member('owner', 'Anna Weber', 'anna@example.com'),
				],
				'en'
			)
		).toBe('Anna Weber or Ben Ito');
	});

	it('falls back to the email address when a name is blank', () => {
		expect(adminDisplayNames([member('owner', '  ', 'anna@example.com')], 'en')).toBe(
			'anna@example.com'
		);
	});

	it('names at most three', () => {
		const admins = ['A', 'B', 'C', 'D'].map((n) => member('admin', n, `${n}@example.com`));
		expect(adminDisplayNames(admins, 'en')).toBe('A, B, or C');
	});

	it('returns null when no admin is known', () => {
		expect(adminDisplayNames([], 'en')).toBeNull();
		expect(adminDisplayNames([member('editor', 'Eve', 'eve@example.com')], 'en')).toBeNull();
	});
});

describe('audience values', () => {
	it('round-trips kind and id', () => {
		expect(decodeAudienceValue(encodeAudienceValue('segment', 'seg_1'))).toEqual({
			kind: 'segment',
			id: 'seg_1',
		});
	});

	it('rejects empty and unknown values', () => {
		expect(decodeAudienceValue('')).toBeNull();
		expect(decodeAudienceValue(null)).toBeNull();
		expect(decodeAudienceValue('list:1')).toBeNull();
		expect(decodeAudienceValue('topic:')).toBeNull();
	});
});
