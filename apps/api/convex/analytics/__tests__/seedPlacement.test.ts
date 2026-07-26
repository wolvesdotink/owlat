import { describe, it, expect } from 'vitest';
import {
	classifySeedFolder,
	isSeedProbeId,
	SEED_PLACEMENTS,
	SEED_PROBE_HEADER,
	type SeedPlacement,
} from '@owlat/shared/seedPlacement';

/**
 * (a) Folder classification across fixture mailboxes: INBOX, Spam, Junk, a
 * Gmail category label, and MISSING — plus the provider-specific folder
 * naming each of the four seedable consumer providers actually uses.
 */
describe('classifySeedFolder — the four outcomes', () => {
	it('classifies INBOX as inbox', () => {
		expect(classifySeedFolder('INBOX', 'gmail')).toEqual({ placement: 'inbox' });
	});

	it('classifies Spam as spam', () => {
		expect(classifySeedFolder('Spam', 'gmail')).toEqual({ placement: 'spam' });
	});

	it('classifies Junk as spam', () => {
		expect(classifySeedFolder('Junk', 'apple')).toEqual({ placement: 'spam' });
	});

	it('classifies a Gmail category label as category, carrying the tab name', () => {
		expect(classifySeedFolder('CATEGORY_PROMOTIONS', 'gmail')).toEqual({
			placement: 'category',
			categoryLabel: 'Promotions',
		});
	});

	it('classifies a not-found probe as MISSING — the outcome no other signal surfaces', () => {
		expect(classifySeedFolder(null, 'gmail')).toEqual({ placement: 'missing' });
		expect(classifySeedFolder(undefined, 'yahoo')).toEqual({ placement: 'missing' });
		expect(classifySeedFolder('   ', 'microsoft')).toEqual({ placement: 'missing' });
	});

	it('only ever returns one of the four declared placements', () => {
		const samples: (string | null)[] = [
			'INBOX',
			'Spam',
			'Junk E-mail',
			'Bulk Mail',
			'[Gmail]/Spam',
			'CATEGORY_UPDATES',
			'Archive',
			null,
		];
		for (const sample of samples) {
			const placement: SeedPlacement = classifySeedFolder(sample, 'gmail').placement;
			expect(SEED_PLACEMENTS).toContain(placement);
		}
	});
});

describe('classifySeedFolder — provider-specific folder naming', () => {
	const cases: {
		provider: 'gmail' | 'microsoft' | 'yahoo' | 'apple' | 'other';
		folder: string;
		placement: SeedPlacement;
	}[] = [
		{ provider: 'gmail', folder: '[Gmail]/Spam', placement: 'spam' },
		{ provider: 'gmail', folder: '[Google Mail]/Spam', placement: 'spam' },
		{ provider: 'microsoft', folder: 'Junk Email', placement: 'spam' },
		{ provider: 'microsoft', folder: 'Junk E-mail', placement: 'spam' },
		{ provider: 'yahoo', folder: 'Bulk Mail', placement: 'spam' },
		{ provider: 'apple', folder: 'Junk', placement: 'spam' },
		{ provider: 'other', folder: 'INBOX.Junk', placement: 'spam' },
		{ provider: 'other', folder: 'INBOX/Spam', placement: 'spam' },
		{ provider: 'other', folder: 'Quarantine', placement: 'spam' },
		{ provider: 'microsoft', folder: 'Inbox', placement: 'inbox' },
		{ provider: 'other', folder: 'inbox', placement: 'inbox' },
	];

	for (const testCase of cases) {
		it(`${testCase.provider}: "${testCase.folder}" → ${testCase.placement}`, () => {
			expect(classifySeedFolder(testCase.folder, testCase.provider).placement).toBe(
				testCase.placement
			);
		});
	}

	it('treats Gmail tab labels as tabs only for gmail seeds', () => {
		expect(classifySeedFolder('Promotions', 'gmail')).toEqual({
			placement: 'category',
			categoryLabel: 'Promotions',
		});
		// Another provider's "Promotions" is a user folder, not a Gmail tab: still
		// filtered away from the inbox, so still `category`, but labelled verbatim.
		expect(classifySeedFolder('Promotions', 'yahoo')).toEqual({
			placement: 'category',
			categoryLabel: 'Promotions',
		});
	});

	it("maps Gmail's Personal tab back to the inbox", () => {
		expect(classifySeedFolder('CATEGORY_PERSONAL', 'gmail')).toEqual({ placement: 'inbox' });
	});

	it('reports an unrecognised folder as category, carrying the raw folder name', () => {
		expect(classifySeedFolder('Newsletters', 'other')).toEqual({
			placement: 'category',
			categoryLabel: 'Newsletters',
		});
	});
});

describe('probe identity', () => {
	it('uses a header name that is stable and namespaced', () => {
		expect(SEED_PROBE_HEADER).toBe('X-Owlat-Seed-Probe');
	});

	it('accepts a well-formed opaque probe id and rejects anything else', () => {
		expect(isSeedProbeId('sp_abcdefghij0123456789kl')).toBe(true);
		expect(isSeedProbeId('sp_short')).toBe(false);
		expect(isSeedProbeId('jane@example.com')).toBe(false);
		expect(isSeedProbeId('')).toBe(false);
	});
});
