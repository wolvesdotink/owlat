/**
 * Output contracts of the reads that scan a token-bearing table and justify,
 * with a `// token-safe:` note, why their rows need no redactor
 * (scripts/check-token-redaction.sh). Each one is called with real sessions
 * over rows that hold a DOI token, an API-key hash or a share token, and the
 * serialized result must carry none of them, while the stored rows keep them.
 *
 * The share-link list is the exception the type-level gate reviews: it hands
 * the token to the owners and admins who manage links, and refuses editors.
 */

import { describe, it, expect } from 'vitest';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { utcDayKey } from '../lib/clock';
import { createTestApiKey, createTestContact, createTestEmailTemplate } from './factories';
import { ADMIN, EDITOR, OWNER, as, authzHarness, type Harness } from './queryAuthzFixtures';

const DOI_TOKEN = 'doi-capability-token';
const KEY_HASH = 'live-key-verifier-hash';
const REVOKED_KEY_HASH = 'revoked-key-verifier-hash';
const SHARE_TOKEN = 'share-capability-token';

/** The serialized value names no capability field and holds no seeded secret. */
function expectNoCapability(value: unknown): void {
	const json = JSON.stringify(value);
	for (const field of ['doiConfirmationToken', 'doiTokenExpiresAt', 'keyHash']) {
		expect(json).not.toContain(`"${field}"`);
	}
	for (const secret of ['doi-secret', DOI_TOKEN, KEY_HASH, REVOKED_KEY_HASH]) {
		expect(json).not.toContain(secret);
	}
}

interface Fixture {
	t: Harness;
	seed: Awaited<ReturnType<typeof authzHarness>>['seed'];
	sunsetContactId: Id<'contacts'>;
	templateId: Id<'emailTemplates'>;
}

/** The authz org plus a second contact with a live DOI token, two keys and a link. */
async function fixture(): Promise<Fixture> {
	const { t, seed } = await authzHarness();
	const ids = await t.run(async (ctx) => {
		const now = Date.now();
		const sunsetContactId = await ctx.db.insert(
			'contacts',
			createTestContact({
				email: 'pending@example.com',
				searchableText: 'pending@example.com',
				doiStatus: 'pending',
				doiConfirmationToken: DOI_TOKEN,
				doiTokenExpiresAt: now + 60_000,
				sunsetStage: 'reengagement',
				sunsetStageAt: now,
			})
		);
		await ctx.db.patch(seed.contactId, { sunsetStage: 'reengagement', sunsetStageAt: now });
		await ctx.db.insert('apiKeys', createTestApiKey({ keyHash: KEY_HASH }));
		await ctx.db.insert(
			'apiKeys',
			createTestApiKey({ keyHash: REVOKED_KEY_HASH, isActive: false })
		);
		const templateId = await ctx.db.insert('emailTemplates', createTestEmailTemplate());
		await ctx.db.insert('shareLinks', {
			targetType: 'emailTemplate',
			emailTemplateId: templateId,
			token: SHARE_TOKEN,
			htmlContent: '<p>Hi</p>',
			subject: 'Hi',
			expiresAt: now + 60_000,
			createdBy: OWNER,
			createdAt: now,
		});
		return { sunsetContactId, templateId };
	});
	return { t, seed, ...ids };
}

describe('token-bearing reads return no capability', () => {
	it('auth.accountManagement.exportContactsForOrganization copies CSV columns only', async () => {
		const { t, seed } = await fixture();
		const exported = await as(t, seed, ADMIN).query(
			api.auth.accountManagement.exportContactsForOrganization,
			{}
		);
		expect(exported.contacts.map((row) => row.email).sort()).toEqual([
			'pending@example.com',
			'reader@example.com',
		]);
		expectNoCapability(exported);
		const stored = await t.run((ctx) => ctx.db.query('contacts').collect());
		expect(stored.map((row) => row.doiConfirmationToken).sort()).toEqual([DOI_TOKEN, 'doi-secret']);
	});

	it.each([false, true])(
		'auth.apiKeys.listByTeam drops keyHash (includeRevoked %s)',
		async (includeRevoked) => {
			const { t, seed } = await fixture();
			const keys = await as(t, seed, ADMIN).query(api.auth.apiKeys.listByTeam, {
				includeRevoked,
			});
			expect(keys).toHaveLength(includeRevoked ? 2 : 1);
			for (const key of keys) expect(key.keyPrefix).toMatch(/^owlat_/);
			expectNoCapability(keys);
			const stored = await t.run((ctx) => ctx.db.query('apiKeys').collect());
			expect(stored.map((key) => key.keyHash).sort()).toEqual([KEY_HASH, REVOKED_KEY_HASH]);
		}
	);

	it('auth.onboarding.getWithActualProgress answers with flags and counts', async () => {
		const { t, seed } = await fixture();
		const progress = await as(t, seed, EDITOR).query(api.auth.onboarding.getWithActualProgress, {
			userId: EDITOR,
		});
		expect(progress).toMatchObject({ addedContacts: true, createdApiKey: true, dismissed: false });
		expect(Object.keys(progress).sort()).toEqual(
			[
				'addedContacts',
				'completedSteps',
				'createdApiKey',
				'createdEmail',
				'dismissed',
				'isComplete',
				'sendPathReady',
				'sentCampaign',
				'setupDomain',
				'totalSteps',
			].sort()
		);
		expectNoCapability(progress);
	});

	it('contacts.analytics.getSubscriberGrowth returns day counts on the scan path', async () => {
		const { t, seed } = await fixture();
		const growth = await as(t, seed, EDITOR).query(api.contacts.analytics.getSubscriberGrowth, {});
		expect(growth.truncated).toBe(false);
		expect(growth.days[growth.days.length - 1]).toMatchObject({
			date: utcDayKey(Date.now()),
			count: 2,
		});
		expectNoCapability(growth);
	});

	it('contacts.analytics.getSubscriberGrowth returns day counts on the counter path', async () => {
		const { t, seed } = await fixture();
		const today = utcDayKey(Date.now());
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('counterScopes', {
				scope: 'contactCreatedDay',
				kind: 'contactCreatedDay',
				isReady: true,
				cursor: null,
				startedAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('counterBuckets', {
				scope: 'contactCreatedDay',
				bucket: today,
				count: 7,
				updatedAt: now,
			});
		});
		const growth = await as(t, seed, EDITOR).query(api.contacts.analytics.getSubscriberGrowth, {});
		expect(growth.days[growth.days.length - 1]).toMatchObject({ date: today, count: 7 });
		expectNoCapability(growth);
	});

	it.each([undefined, 'pending'])(
		'contacts.organization.listAllIdsByOrganization returns ids only (search %s)',
		async (search) => {
			const { t, seed, sunsetContactId } = await fixture();
			const result = await as(t, seed, ADMIN).query(
				api.contacts.organization.listAllIdsByOrganization,
				{ search }
			);
			expect(Object.keys(result).sort()).toEqual(['ids', 'truncated']);
			expect(result.ids).toContain(sunsetContactId);
			for (const id of result.ids) expect(typeof id).toBe('string');
			expectNoCapability(result);
		}
	);

	it('contacts.sunset.listSunsetStage projects every page to the sunset fields', async () => {
		const { t, seed } = await fixture();
		const caller = as(t, seed, ADMIN);
		const stagePage = (cursor: string | null) =>
			caller.query(api.contacts.sunset.listSunsetStage, {
				stage: 'reengagement',
				paginationOpts: { numItems: 1, cursor },
			});
		const first = await stagePage(null);
		const second = await stagePage(first.continueCursor);
		const rows = [...first.page, ...second.page];
		expect(rows.map((row) => row.email).sort()).toEqual([
			'pending@example.com',
			'reader@example.com',
		]);
		for (const row of rows) {
			expect(Object.keys(row).sort()).toEqual(
				[
					'contactId',
					'email',
					'firstName',
					'isExempt',
					'lastName',
					'sunsetStage',
					'sunsetStageAt',
				].sort()
			);
		}
		expectNoCapability(rows);
	});
});

describe('shareLinks.listShareLinks delivers the token to link managers only', () => {
	it.each([OWNER, ADMIN] as const)(
		'%s receives the token the copy action needs',
		async (caller) => {
			const { t, seed, templateId } = await fixture();
			const links = await as(t, seed, caller).query(api.shareLinks.listShareLinks, {
				emailTemplateId: templateId,
			});
			expect(links.map((link) => link.token)).toEqual([SHARE_TOKEN]);
		}
	);

	it('refuses an editor', async () => {
		const { t, seed, templateId } = await fixture();
		await expect(
			as(t, seed, EDITOR).query(api.shareLinks.listShareLinks, { emailTemplateId: templateId })
		).rejects.toMatchObject({ data: { category: 'forbidden' } });
	});
});
