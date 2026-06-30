/**
 * Regression tests locking in the soft-delete / GDPR-erasure contract.
 *
 * A soft-deleted contact (`deletedAt` set, email retained on the gravestone
 * row) must NEVER re-surface its PII through any read path. We seed one LIVE
 * contact and one SOFT-DELETED contact and assert the soft-deleted one is
 * absent from every covered query. The last group asserts the hard-delete
 * cascade scrubs `transactionalSends.dataVariables`.
 *
 * Source under test:
 *   - contacts/organization.ts  (listForExportByOrganization,
 *     listAllIdsByOrganization, getPropertyValuesForContacts)
 *   - globalSearch.ts           (search → contacts branch)
 *   - contacts/timeline.ts      (getTimeline, getTimelineStats)
 *   - contacts/contacts.ts      (getByEmailForTeam)
 *   - transactional/sends.ts    (get, listAll, getByEmail,
 *     listByTransactionalEmail)
 *   - lib/contactMutations.ts   (permanentlyDeleteContactWithRelations)
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { createTestContact, createTestTransactionalEmail } from './factories';
import type { Id } from '../_generated/dataModel';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireAdminContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireAuthenticatedIdentity: vi.fn().mockResolvedValue({ subject: 'test-user', issuer: 'test', tokenIdentifier: 'test|test-user' }),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) =>
		!path.includes('sesActions') &&
		!path.includes('agentSecurity') &&
		!path.includes('agentContext') &&
		!path.includes('agentClassifier') &&
		!path.includes('agentDrafter') &&
		!path.includes('agentRouter') &&
		!path.includes('agent/walker') &&
		!path.includes('agent/steps/index') &&
		!path.includes('agent/steps/shared') &&
		!path.includes('agent/steps/classify') &&
		!path.includes('agent/steps/draft') &&
		!path.includes('knowledgeExtraction') &&
		!path.includes('semanticFileProcessing') &&
		!path.includes('visualizationAgent') &&
		!path.includes('llmProvider')
	)
);

// ------------------------------------------------------------------
// Shared fixture: one LIVE contact + one SOFT-DELETED gravestone whose
// email is RETAINED on the row (the whole point of the contract: the
// address lingers but must read as absent everywhere).
// ------------------------------------------------------------------

const LIVE_EMAIL = 'live@example.com';
const DELETED_EMAIL = 'erased@example.com';

interface Fixture {
	t: ReturnType<typeof convexTest>;
	liveId: Id<'contacts'>;
	deletedId: Id<'contacts'>;
}

async function seedFixture(): Promise<Fixture> {
	const t = convexTest(schema, modules);
	let liveId: Id<'contacts'>;
	let deletedId: Id<'contacts'>;

	await t.run(async (ctx) => {
		liveId = await ctx.db.insert(
			'contacts',
			createTestContact({
				email: LIVE_EMAIL,
				firstName: 'Live',
				lastName: 'Person',
				searchableText: `${LIVE_EMAIL} live person zzsharedtoken`,
			})
		);
		// Soft-deleted gravestone: deletedAt set, email RETAINED on the row.
		deletedId = await ctx.db.insert(
			'contacts',
			createTestContact({
				email: DELETED_EMAIL,
				firstName: 'Erased',
				lastName: 'Person',
				searchableText: `${DELETED_EMAIL} erased person zzsharedtoken`,
				deletedAt: Date.now(),
				deletedBy: 'test-user',
			})
		);
	});

	return { t, liveId: liveId!, deletedId: deletedId! };
}

// ==================================================================
// contacts/organization.ts
// ==================================================================

describe('contacts/organization.listForExportByOrganization', () => {
	it('excludes the soft-deleted contact (no-search branch)', async () => {
		const { t, liveId, deletedId } = await seedFixture();

		const rows = await t.query(api.contacts.organization.listForExportByOrganization, {});

		const ids = rows.map((c) => c._id);
		expect(ids).toContain(liveId);
		expect(ids).not.toContain(deletedId);
		expect(rows.every((c) => c.email !== DELETED_EMAIL)).toBe(true);
	});

	it('excludes the soft-deleted contact (search branch)', async () => {
		const { t, liveId, deletedId } = await seedFixture();

		// Both rows share "zzsharedtoken" in searchableText, so a naive search
		// would return both — only the live one may surface.
		const rows = await t.query(api.contacts.organization.listForExportByOrganization, {
			search: 'zzsharedtoken',
		});

		const ids = rows.map((c) => c._id);
		expect(ids).toContain(liveId);
		expect(ids).not.toContain(deletedId);
	});
});

describe('contacts/organization.listAllIdsByOrganization', () => {
	it('excludes the soft-deleted contact (no-search branch)', async () => {
		const { t, liveId, deletedId } = await seedFixture();

		const result = await t.query(api.contacts.organization.listAllIdsByOrganization, {});

		expect(result.ids).toContain(liveId);
		expect(result.ids).not.toContain(deletedId);
		expect(result.truncated).toBe(false);
	});

	it('excludes the soft-deleted contact (search branch)', async () => {
		const { t, liveId, deletedId } = await seedFixture();

		const result = await t.query(api.contacts.organization.listAllIdsByOrganization, {
			search: 'zzsharedtoken',
		});

		expect(result.ids).toContain(liveId);
		expect(result.ids).not.toContain(deletedId);
	});
});

describe('contacts/organization.getPropertyValuesForContacts', () => {
	it('skips a soft-deleted contact even when its id is passed', async () => {
		const { t, liveId, deletedId } = await seedFixture();

		// Seed a property value for BOTH contacts so the only thing keeping the
		// erased one out is the deletedAt guard, not a missing row.
		await t.run(async (ctx) => {
			const propertyId = await ctx.db.insert('contactProperties', {
				key: 'favorite_color',
				label: 'Favorite Color',
				type: 'string',
				createdAt: Date.now(),
			});
			await ctx.db.insert('contactPropertyValues', {
				contactId: liveId,
				propertyId,
				value: 'blue',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('contactPropertyValues', {
				contactId: deletedId,
				propertyId,
				value: 'red',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const result = await t.query(api.contacts.organization.getPropertyValuesForContacts, {
			contactIds: [liveId, deletedId],
		});

		expect(result[liveId]).toBeDefined();
		expect(result[deletedId]).toBeUndefined();
	});
});

// ==================================================================
// globalSearch.ts (contacts branch)
// ==================================================================

describe('globalSearch.search', () => {
	it('omits the soft-deleted contact from the contacts results', async () => {
		const { t, liveId, deletedId } = await seedFixture();

		const result = await t.query(api.globalSearch.search, {
			query: 'zzsharedtoken',
		});

		const ids = result.contacts.map((c) => c.id);
		expect(ids).toContain(liveId);
		expect(ids).not.toContain(deletedId);
		// PII (email) of the erased contact must not leak via subtitle either.
		expect(result.contacts.every((c) => c.subtitle !== DELETED_EMAIL)).toBe(true);
	});
});

// ==================================================================
// contacts/timeline.ts
// ==================================================================

describe('contacts/timeline.getTimeline', () => {
	it('returns the live contact’s timeline entries', async () => {
		const { t, liveId } = await seedFixture();

		await t.run(async (ctx) => {
			await ctx.db.insert('contactActivities', {
				contactId: liveId,
				activityType: 'email_opened',
				metadata: {},
				occurredAt: Date.now(),
			});
		});

		const timeline = await t.query(api.contacts.timeline.getTimeline, {
			contactId: liveId,
		});

		expect(timeline.length).toBe(1);
	});

	it('returns an empty timeline for a soft-deleted contact even with child rows', async () => {
		const { t, deletedId } = await seedFixture();

		// Seed activity + message rows for the erased contact — the guard must
		// short-circuit before reading the child tables.
		await t.run(async (ctx) => {
			await ctx.db.insert('contactActivities', {
				contactId: deletedId,
				activityType: 'email_opened',
				metadata: {},
				occurredAt: Date.now(),
			});
			const threadId = await ctx.db.insert('conversationThreads', {
				subject: 'secret',
				normalizedSubject: 'secret',
				contactId: deletedId,
				contactIdentifier: DELETED_EMAIL,
				status: 'open',
				messageCount: 1,
				lastMessageAt: Date.now(),
				firstMessageAt: Date.now(),
				createdAt: Date.now(),
			});
			await ctx.db.insert('unifiedMessages', {
				threadId,
				contactId: deletedId,
				channel: 'email',
				direction: 'inbound',
				content: JSON.stringify({ text: 'private body' }),
				status: 'received',
				createdAt: Date.now(),
			});
		});

		const timeline = await t.query(api.contacts.timeline.getTimeline, {
			contactId: deletedId,
		});

		expect(timeline).toEqual([]);
	});
});

describe('contacts/timeline.getTimelineStats', () => {
	it('returns zeroed stats for a soft-deleted contact even with child rows', async () => {
		const { t, deletedId } = await seedFixture();

		await t.run(async (ctx) => {
			await ctx.db.insert('contactActivities', {
				contactId: deletedId,
				activityType: 'email_opened',
				metadata: {},
				occurredAt: Date.now(),
			});
			const threadId = await ctx.db.insert('conversationThreads', {
				subject: 'secret',
				normalizedSubject: 'secret',
				contactId: deletedId,
				contactIdentifier: DELETED_EMAIL,
				status: 'open',
				messageCount: 1,
				lastMessageAt: Date.now(),
				firstMessageAt: Date.now(),
				createdAt: Date.now(),
			});
			await ctx.db.insert('unifiedMessages', {
				threadId,
				contactId: deletedId,
				channel: 'email',
				direction: 'inbound',
				content: JSON.stringify({ text: 'private body' }),
				status: 'received',
				createdAt: Date.now(),
			});
		});

		const stats = await t.query(api.contacts.timeline.getTimelineStats, {
			contactId: deletedId,
		});

		expect(stats.totalMessages).toBe(0);
		expect(stats.totalActivities).toBe(0);
		expect(stats.totalThreads).toBe(0);
		expect(stats.channelCounts).toEqual({});
		expect(stats.activityCounts).toEqual({});
		expect(stats.firstInteraction).toBeNull();
		expect(stats.lastInteraction).toBeNull();
	});
});

// ==================================================================
// contacts/contacts.ts getByEmailForTeam (internalQuery)
// ==================================================================

describe('contacts/contacts.getByEmailForTeam', () => {
	it('returns the live contact by email', async () => {
		const { t, liveId } = await seedFixture();

		const found = await t.query(internal.contacts.contacts.getByEmailForTeam, {
			email: LIVE_EMAIL,
		});

		expect(found).not.toBeNull();
		expect(found!._id).toBe(liveId);
	});

	it('returns null for a soft-deleted gravestone whose email is retained', async () => {
		const { t } = await seedFixture();

		const found = await t.query(internal.contacts.contacts.getByEmailForTeam, {
			email: DELETED_EMAIL,
		});

		expect(found).toBeNull();
	});
});

// ==================================================================
// transactional/sends.ts
// ==================================================================

interface SendsFixture {
	t: ReturnType<typeof convexTest>;
	liveId: Id<'contacts'>;
	deletedId: Id<'contacts'>;
	templateId: Id<'transactionalEmails'>;
	liveSendId: Id<'transactionalSends'>;
	deletedSendId: Id<'transactionalSends'>;
}

async function seedSendsFixture(): Promise<SendsFixture> {
	const base = await seedFixture();
	const { t, liveId, deletedId } = base;
	let templateId: Id<'transactionalEmails'>;
	let liveSendId: Id<'transactionalSends'>;
	let deletedSendId: Id<'transactionalSends'>;

	await t.run(async (ctx) => {
		templateId = await ctx.db.insert('transactionalEmails', createTestTransactionalEmail());
		liveSendId = await ctx.db.insert('transactionalSends', {
			kind: 'transactional',
			transactionalEmailId: templateId,
			email: LIVE_EMAIL,
			contactId: liveId,
			status: 'delivered',
			queuedAt: Date.now(),
			sentAt: Date.now(),
			openCount: 0,
		});
		// A soft-deleted (erased) send: deletedAt set, email retained as the
		// scrubbed gravestone. It must read as absent everywhere.
		deletedSendId = await ctx.db.insert('transactionalSends', {
			kind: 'transactional',
			transactionalEmailId: templateId,
			email: DELETED_EMAIL,
			contactId: deletedId,
			status: 'delivered',
			queuedAt: Date.now(),
			sentAt: Date.now(),
			openCount: 0,
			deletedAt: Date.now(),
			deletedBy: 'system',
		});
	});

	return { ...base, templateId: templateId!, liveSendId: liveSendId!, deletedSendId: deletedSendId! };
}

describe('transactional/sends.get', () => {
	it('returns the live send', async () => {
		const { t, liveSendId } = await seedSendsFixture();
		const send = await t.query(api.transactional.sends.get, { id: liveSendId });
		expect(send).not.toBeNull();
		expect(send!._id).toBe(liveSendId);
	});

	it('returns null for a soft-deleted send', async () => {
		const { t, deletedSendId } = await seedSendsFixture();
		const send = await t.query(api.transactional.sends.get, { id: deletedSendId });
		expect(send).toBeNull();
	});
});

describe('transactional/sends.listAll', () => {
	it('excludes the soft-deleted send', async () => {
		const { t, liveSendId, deletedSendId } = await seedSendsFixture();
		const result = await t.query(api.transactional.sends.listAll, {});
		const ids = result.sends.map((s) => s._id);
		expect(ids).toContain(liveSendId);
		expect(ids).not.toContain(deletedSendId);
	});
});

describe('transactional/sends.getByEmail', () => {
	it('returns no rows for the erased recipient address', async () => {
		const { t } = await seedSendsFixture();
		const rows = await t.query(api.transactional.sends.getByEmail, { email: DELETED_EMAIL });
		expect(rows).toEqual([]);
	});

	it('returns the live send for the live recipient address', async () => {
		const { t, liveSendId } = await seedSendsFixture();
		const rows = await t.query(api.transactional.sends.getByEmail, { email: LIVE_EMAIL });
		const ids = rows.map((s) => s._id);
		expect(ids).toContain(liveSendId);
	});
});

describe('transactional/sends.listByTransactionalEmail', () => {
	it('excludes the soft-deleted send for the template', async () => {
		const { t, templateId, liveSendId, deletedSendId } = await seedSendsFixture();
		const result = await t.query(api.transactional.sends.listByTransactionalEmail, {
			transactionalEmailId: templateId,
		});
		const ids = result.sends.map((s) => s._id);
		expect(ids).toContain(liveSendId);
		expect(ids).not.toContain(deletedSendId);
	});
});

// ==================================================================
// lib/contactMutations.ts permanentlyDeleteContactWithRelations
// ==================================================================

describe('lib/contactMutations.permanentlyDeleteContactWithRelations', () => {
	it('scrubs transactionalSends dataVariables (and email) on hard delete', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;
		let sendId: Id<'transactionalSends'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'tobedeleted@example.com' })
			);
			sendId = await ctx.db.insert('transactionalSends', {
				kind: 'transactional',
				email: 'tobedeleted@example.com',
				contactId,
				status: 'delivered',
				queuedAt: Date.now(),
				sentAt: Date.now(),
				openCount: 0,
				// PII-bearing request variables that erasure must drop.
				dataVariables: { firstName: 'Top', lastName: 'Secret', orderId: '12345' },
			});
		});

		// Drive the cascade directly via a one-off internalMutation harness.
		await t.run(async (ctx) => {
			const { permanentlyDeleteContactWithRelations } = await import('../lib/contactMutations');
			await permanentlyDeleteContactWithRelations(ctx, contactId);
		});

		await t.run(async (ctx) => {
			// Contact row is gone.
			expect(await ctx.db.get(contactId)).toBeNull();
			// The send row survives (soft-deleted for stat integrity) but is scrubbed.
			const send = await ctx.db.get(sendId);
			expect(send).not.toBeNull();
			expect(send!.deletedAt).toBeDefined();
			expect(send!.dataVariables).toBeUndefined();
			expect(send!.email).toBe('[erased]');
		});
	});
});
