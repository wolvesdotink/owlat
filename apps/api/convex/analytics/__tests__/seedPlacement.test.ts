import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import { internal } from '../../_generated/api';
import schema from '../../schema';
import { insertExternalAccountRow } from '../../mail/externalAccountShared';
import type { Id } from '../../_generated/dataModel';
import { modules } from './testModules';
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

	it('only ever returns one of the declared placements', () => {
		const samples: (string | null)[] = [
			'INBOX',
			'Spam',
			'Junk E-mail',
			'Bulk Mail',
			'[Gmail]/Spam',
			'CATEGORY_UPDATES',
			'Archive',
			'Deleted Items',
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
		{ provider: 'gmail', folder: '[Gmail]/Trash', placement: 'deleted' },
		{ provider: 'microsoft', folder: 'Deleted Items', placement: 'deleted' },
		{ provider: 'yahoo', folder: 'Trash', placement: 'deleted' },
		{ provider: 'other', folder: 'Bin', placement: 'deleted' },
		{ provider: 'other', folder: 'Deleted Messages', placement: 'deleted' },
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
		expect(isSeedProbeId('sp_a1b2c3d4e5f60718293a4b')).toBe(true);
		expect(isSeedProbeId('sp_short')).toBe(false);
		expect(isSeedProbeId('jane@example.com')).toBe(false);
		expect(isSeedProbeId('')).toBe(false);
	});

	it('accepts EXACTLY the minted alphabet — the id is hex, not base32', () => {
		// `newProbeId` slices a hyphen-stripped UUIDv4, so every character is
		// [0-9a-f]. The guard is load-bearing at two PUBLIC tracking endpoints, so
		// the accepted set must not be one character wider than the minted set.
		expect(isSeedProbeId('sp_0123456789abcdef012345')).toBe(true);
		// A `[g-z]` sample: right prefix, right length, wrong alphabet.
		expect(isSeedProbeId('sp_ghijklmnopqrstuvwxyz01')).toBe(false);
		expect(isSeedProbeId('sp_abcdefghij0123456789kl')).toBe(false);
		// Uppercase hex is not minted either.
		expect(isSeedProbeId('sp_0123456789ABCDEF012345')).toBe(false);
		// One character short, one character long.
		expect(isSeedProbeId('sp_0123456789abcdef01234')).toBe(false);
		expect(isSeedProbeId('sp_0123456789abcdef0123456')).toBe(false);
		// No leading/trailing slop — the pattern is anchored.
		expect(isSeedProbeId(' sp_0123456789abcdef012345')).toBe(false);
		expect(isSeedProbeId('xsp_0123456789abcdef012345')).toBe(false);
	});
});

/**
 * ADVERSARIAL: the folder name is REMOTE input.
 *
 * It comes off an IMAP server whose software the operator does not choose, so
 * a pathological name — unbounded length, embedded control characters — must
 * not be persisted verbatim on a row that is written once per seed per
 * campaign and read back into an operator-facing surface.
 */
describe('a hostile remote folder name is bounded before it is stored', () => {
	const ORG = 'org_folder_clamp';
	const NOW = 1_800_000_000_000;
	const PROBE_ID = 'sp_0123456789abcdef012345';

	async function probeRow(t: ReturnType<typeof convexTest>): Promise<Id<'seedPlacementProbes'>> {
		return t.run(async (ctx) => {
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: 'user_1',
				organizationId: ORG,
				address: 'owlat.seed.09@gmail.example',
				domain: 'gmail.example',
				kind: 'external' as const,
				status: 'active' as const,
				usedBytes: 0,
				uidValidity: NOW,
				createdAt: NOW,
				updatedAt: NOW,
			});
			const accountId = await insertExternalAccountRow(ctx, {
				userId: 'user_1',
				organizationId: ORG,
				mailboxId,
				address: 'owlat.seed.09@gmail.example',
				seed: { seedProvider: 'gmail' },
				fields: {
					imapHost: 'imap.gmail.example',
					imapPort: 993,
					isImapSecure: true,
					smtpHost: 'smtp.gmail.example',
					smtpPort: 465,
					isSmtpSecure: true,
					authMethod: 'password' as const,
					imapUsername: 'login-9',
					secretCiphertext: 'ct',
					secretIv: 'iv',
					secretAuthTag: 'tag',
					secretEnvelopeVersion: 1,
				},
				now: NOW,
			});
			return ctx.db.insert('seedPlacementProbes', {
				organizationId: ORG,
				probeId: PROBE_ID,
				accountId,
				provider: 'gmail',
				stream: 'campaign' as const,
				sentAt: NOW,
				dispatchedAt: NOW,
				expiresAt: NOW + 1_000,
			});
		});
	}

	it('clamps a pathologically long folder name, and the label derived from it', async () => {
		const t = convexTest(schema, modules);
		const ref = await probeRow(t);
		const hostile = 'A'.repeat(50_000);

		const outcome = await t.mutation(
			internal.analytics.seedPlacement.recordSeedProbeClassification,
			{ organizationId: ORG, probeId: PROBE_ID, folderName: hostile, now: NOW + 10, clickRoll: 0.9 }
		);
		// The CLASSIFICATION is unaffected — clamping is about what we persist.
		expect(outcome).toMatchObject({ recorded: true, placement: 'category' });

		const row = await t.run(async (ctx) => ctx.db.get(ref));
		expect(row?.folderName?.length).toBe(256);
		expect(row?.categoryLabel?.length).toBe(256);
	});

	it('strips control characters so a folder name cannot forge a log line', async () => {
		const t = convexTest(schema, modules);
		const ref = await probeRow(t);

		await t.mutation(internal.analytics.seedPlacement.recordSeedProbeClassification, {
			organizationId: ORG,
			probeId: PROBE_ID,
			folderName: 'News\r\nWARN forged tail',
			now: NOW + 10,
			clickRoll: 0.9,
		});

		const row = await t.run(async (ctx) => ctx.db.get(ref));
		expect(row?.folderName).toBe('News  WARN forged tail');
		expect(row?.folderName).not.toContain('\r');
		expect(row?.folderName).not.toContain('\n');
	});

	it('leaves an ordinary folder name completely alone', async () => {
		const t = convexTest(schema, modules);
		const ref = await probeRow(t);

		await t.mutation(internal.analytics.seedPlacement.recordSeedProbeClassification, {
			organizationId: ORG,
			probeId: PROBE_ID,
			folderName: '[Gmail]/Spam',
			now: NOW + 10,
			clickRoll: 0.9,
		});

		const row = await t.run(async (ctx) => ctx.db.get(ref));
		expect(row?.folderName).toBe('[Gmail]/Spam');
		expect(row?.placement).toBe('spam');
	});
});
