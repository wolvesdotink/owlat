/**
 * Sharing a knowledge entry that migration 0069 restricted with members again
 * (#1372, knowledge/sharing.ts). Owners and admins only, after a review of the
 * complete content, tags and contact links, recorded in the audit log, and
 * never for an entry whose source still keeps it from members: Team Inbox
 * knowledge, a mail capture, a source that is gone or unknown, also once the
 * entry was turned into a curated answer.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import {
	createTestContact,
	createTestConversationThread,
	createTestInboundMessage,
	createTestKnowledgeEntry,
	enableFeatures,
} from './factories';
import { MIGRATION } from '../migrations/0069_restrict_captured_file_knowledge';
import { RESTRICTION_MIGRATION } from '../knowledge/sharing';
import type * as SessionOrganization from '../lib/sessionOrganization';

const sessionMock = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'admin' | 'editor' }));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganization>('../lib/sessionOrganization');
	const session = () => ({
		userId: `user-${sessionMock.role}`,
		role: sessionMock.role,
		activeOrganizationId: 'test-org',
	});
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(async () => session()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: vi.fn().mockImplementation(async () => session()),
		getUserIdFromSession: vi.fn().mockImplementation(async () => session().userId),
		getMutationContext: vi.fn().mockImplementation(async () => session()),
		requireAdminContext: vi.fn().mockImplementation(async () => {
			if (!actual.hasPermission(sessionMock.role, 'organization:manage')) {
				throw new Error('Only owners and admins can perform this action');
			}
			return session();
		}),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

type T = TestConvex<typeof schema>;
const migration = internal.migrations[MIGRATION];

beforeEach(() => {
	sessionMock.role = 'owner';
	// Only the scheduler's timers: creation times and the walk's start time are real.
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
	vi.useRealTimers();
});

/** Let the wall clock move past every row written so far. */
function tick(): void {
	const until = Date.now() + 3;
	while (Date.now() < until) {
		// spin
	}
}

async function setup(): Promise<T> {
	const t = convexTest(schema, modules);
	await enableFeatures(t, ['ai.knowledge']);
	return t;
}

async function runMigration(t: T): Promise<void> {
	tick();
	await t.mutation(migration.run, {});
	await t.finishAllScheduledFunctions(vi.runAllTimers);
}

const seedEntry = (t: T, fields: Record<string, unknown>) =>
	t.run((ctx) =>
		ctx.db.insert(
			'knowledgeEntries',
			createTestKnowledgeEntry({ embedding: [], ...fields }) as Doc<'knowledgeEntries'>
		)
	);

const seedFile = (t: T, fields: Partial<Doc<'semanticFiles'>> = {}) =>
	t.run((ctx) =>
		ctx.db.insert('semanticFiles', {
			filename: 'f.txt',
			mimeType: 'text/plain',
			fileSize: 1,
			sourceType: 'upload',
			version: 1,
			embedding: [],
			createdAt: 1,
			updatedAt: 1,
			...fields,
		})
	);

/** A Team Inbox message on a real thread of a real contact. */
const seedInboundMessage = (t: T) =>
	t.run(async (ctx) => {
		const contactId = await ctx.db.insert('contacts', createTestContact() as Doc<'contacts'>);
		// The factory still carries an `updatedAt` the table no longer has.
		const { updatedAt: _updatedAt, ...thread } = createTestConversationThread({ contactId });
		const threadId = await ctx.db.insert(
			'conversationThreads',
			thread as Doc<'conversationThreads'>
		);
		const messageId = await ctx.db.insert(
			'inboundMessages',
			createTestInboundMessage({ contactId, threadId }) as Doc<'inboundMessages'>
		);
		return { messageId, threadId };
	});

const read = (t: T, id: Id<'knowledgeEntries'>) => t.run(async (ctx) => (await ctx.db.get(id))!);

const auditRows = (t: T) =>
	t.run((ctx) =>
		ctx.db
			.query('auditLogs')
			.withIndex('by_action', (q) => q.eq('action', 'knowledge.entry_shared'))
			.collect()
	);

async function review(t: T, entryId: Id<'knowledgeEntries'>) {
	const result = await t.query(api.knowledge.sharing.getShareReview, { entryId });
	if (!result) throw new Error('no review');
	return result;
}

async function share(t: T, entryId: Id<'knowledgeEntries'>) {
	const { fingerprint } = await review(t, entryId);
	return t.mutation(api.knowledge.sharing.shareWithMembers, { entryId, fingerprint });
}

describe('sharing a restricted knowledge entry with members', () => {
	it('names the migration it waits for', () => {
		expect(RESTRICTION_MIGRATION).toBe(MIGRATION);
	});

	it('opens an entry 0069 restricted to members after an owner reviews it', async () => {
		const t = await setup();
		const contactId = await t.run((ctx) =>
			ctx.db.insert(
				'contacts',
				createTestContact({
					firstName: 'Jonas',
					lastName: 'Weber',
					email: 'jonas@example.com',
				}) as Doc<'contacts'>
			)
		);
		const goneContactId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('contacts', createTestContact() as Doc<'contacts'>);
			await ctx.db.delete(id);
			return id;
		});
		const softDeletedContactId = await t.run((ctx) =>
			ctx.db.insert(
				'contacts',
				createTestContact({
					firstName: 'Mara',
					lastName: 'Lind',
					email: 'mara@example.com',
					deletedAt: 1,
				}) as Doc<'contacts'>
			)
		);
		const entryId = await t.mutation(api.knowledge.graph.createEntry, {
			entryType: 'fact',
			title: 'Jonas prefers a call',
			content: 'Call Jonas before any sharedtoken scope change.',
			sourceType: 'manual',
			contactIds: [contactId, goneContactId, softDeletedContactId],
			tags: ['harborline'],
		});
		await runMigration(t);
		expect((await read(t, entryId)).memberAccess).toBe('restricted');

		// A member cannot see it, review it or share it.
		sessionMock.role = 'editor';
		expect(await t.query(api.knowledge.graph.getEntry, { entryId })).toBeNull();
		expect(await t.query(api.knowledge.sharing.getShareReview, { entryId })).toBeNull();
		await expect(
			t.mutation(api.knowledge.sharing.shareWithMembers, { entryId, fingerprint: 'x' })
		).rejects.toThrow();

		// The owner reviews the complete entry, contact links by name.
		sessionMock.role = 'owner';
		const shown = await review(t, entryId);
		expect(shown).toMatchObject({
			title: 'Jonas prefers a call',
			content: 'Call Jonas before any sharedtoken scope change.',
			tags: ['harborline'],
			blocker: null,
			contacts: [
				{ contactId, name: 'Jonas Weber', email: 'jonas@example.com' },
				{ contactId: goneContactId, name: null, email: null },
				{ contactId: softDeletedContactId, name: null, email: null },
			],
		});
		expect(await share(t, entryId)).toBe(entryId);
		expect((await read(t, entryId)).memberAccess).toBe('members');

		// Members read it, list it, find it, and the agent retrieves it for them.
		sessionMock.role = 'editor';
		expect((await t.query(api.knowledge.graph.getEntry, { entryId }))?.entry._id).toBe(entryId);
		const listed = await t.query(api.knowledge.graph.listAll, {});
		expect(listed.map((e) => e._id)).toContain(entryId);
		const byContact = await t.query(api.knowledge.graph.getByContact, { contactId });
		expect(byContact.map((e) => e._id)).toContain(entryId);
		const retrieved = await t.action(internal.knowledge.retrieval.semanticSearch, {
			queryText: 'sharedtoken',
			scopeToContact: 'org-wide',
			includeInboxDerived: false,
			limit: 10,
		});
		expect(retrieved.map((e) => e._id)).toContain(entryId);

		const [audit, ...more] = await auditRows(t);
		expect(more).toEqual([]);
		expect(audit).toMatchObject({
			userId: 'user-owner',
			organizationId: 'test-org',
			resource: 'knowledge_entry',
			resourceId: entryId,
			details: { from: 'restricted', to: 'members', sourceType: 'manual' },
		});
	});

	it('lets an admin share too', async () => {
		const t = await setup();
		const entryId = await seedEntry(t, { sourceType: 'manual', memberAccess: 'restricted' });
		sessionMock.role = 'admin';
		await share(t, entryId);
		expect((await read(t, entryId)).memberAccess).toBe('members');
		expect((await auditRows(t))[0]?.userId).toBe('user-admin');
	});

	it('does nothing while the knowledge feature is off', async () => {
		const t = convexTest(schema, modules);
		const entryId = await seedEntry(t, { sourceType: 'manual', memberAccess: 'restricted' });
		expect(await t.query(api.knowledge.sharing.getShareReview, { entryId })).toBeNull();
		await expect(
			t.mutation(api.knowledge.sharing.shareWithMembers, { entryId, fingerprint: 'x' })
		).rejects.toThrow();
		expect((await read(t, entryId)).memberAccess).toBe('restricted');
	});

	it('opens a restricted entry from an uploaded file', async () => {
		const t = await setup();
		const upload = await seedFile(t, { sourceType: 'upload' });
		const entryId = await seedEntry(t, {
			sourceType: 'file',
			sourceId: upload,
			memberAccess: 'restricted',
		});
		expect((await review(t, entryId)).blocker).toBeNull();
		await share(t, entryId);
		sessionMock.role = 'editor';
		expect(await t.query(api.knowledge.graph.getEntry, { entryId })).not.toBeNull();
	});

	describe('refuses an entry whose source keeps it from members', () => {
		const cases: Array<[string, (t: T) => Promise<Record<string, unknown>>, string]> = [
			[
				'Team Inbox extraction',
				async (t) => ({
					sourceType: 'agent_extracted',
					sourceId: (await seedInboundMessage(t)).messageId,
				}),
				'team_inbox',
			],
			[
				'a Team Inbox thread link',
				async (t) => ({
					sourceType: 'manual',
					threadId: (await seedInboundMessage(t)).threadId,
				}),
				'team_inbox',
			],
			[
				'a curated answer made from Team Inbox knowledge',
				async (t) => ({
					sourceType: 'curated',
					isAuthoritative: true,
					sourceId: (await seedInboundMessage(t)).messageId,
				}),
				'team_inbox',
			],
			[
				'a Postbox mail capture',
				async (t) => ({
					sourceType: 'file',
					sourceId: await seedFile(t, { sourceType: 'email_attachment' }),
				}),
				'mail_capture',
			],
			[
				'a Team Inbox mail capture',
				async (t) => ({
					sourceType: 'file',
					sourceId: await seedFile(t, { captureSource: 'team_inbox' }),
				}),
				'mail_capture',
			],
			[
				'a curated answer made from a mail capture',
				async (t) => ({
					sourceType: 'curated',
					isAuthoritative: true,
					sourceId: await seedFile(t, { sourceType: 'email_attachment' }),
				}),
				'mail_capture',
			],
			[
				'a deleted source file',
				async (t) => ({
					sourceType: 'file',
					sourceId: await seedFile(t).then(async (id) => {
						await t.run((ctx) => ctx.db.delete(id));
						return id;
					}),
				}),
				'source_missing',
			],
			[
				'a file entry with no recorded source',
				async () => ({ sourceType: 'file' }),
				'source_missing',
			],
			[
				'a file entry whose source is not a file',
				async () => ({ sourceType: 'file', sourceId: 'not-an-id' }),
				'source_missing',
			],
			[
				'a curated answer made from a file entry with no recorded source',
				async () => ({
					sourceType: 'curated',
					curatedFromSourceType: 'file',
					isAuthoritative: true,
				}),
				'source_missing',
			],
			[
				'a curated answer made from Team Inbox extraction with no recorded source',
				async () => ({
					sourceType: 'curated',
					curatedFromSourceType: 'agent_extracted',
					isAuthoritative: true,
				}),
				'team_inbox',
			],
			[
				'a curated answer written before its earlier source was recorded',
				async () => ({ sourceType: 'curated', isAuthoritative: true }),
				'source_missing',
			],
		];

		it.each(cases.map(([name, fields, blocker]) => [name, blocker, fields] as const))(
			'%s: %s',
			async (_name, blocker, fields) => {
				const t = await setup();
				const entryId = await seedEntry(t, { ...(await fields(t)), memberAccess: 'restricted' });
				const shown = await review(t, entryId);
				expect(shown.blocker).toBe(blocker);
				await expect(
					t.mutation(api.knowledge.sharing.shareWithMembers, {
						entryId,
						fingerprint: shown.fingerprint,
					})
				).rejects.toThrow();
				expect((await read(t, entryId)).memberAccess).toBe('restricted');
				expect(await auditRows(t)).toEqual([]);
			}
		);
	});

	describe('a curated answer keeps the source it was made from', () => {
		const promote = (t: T, entryId: Id<'knowledgeEntries'>, title = 'Promoted') =>
			t.mutation(api.knowledge.graph.createPolicyEntry, {
				entryId,
				title,
				content: 'The answer',
			});

		it('a file entry with no recorded source stays unshareable', async () => {
			const t = await setup();
			const entryId = await seedEntry(t, { sourceType: 'file', memberAccess: 'restricted' });
			expect((await review(t, entryId)).blocker).toBe('source_missing');

			await promote(t, entryId);
			// Re-saving the answer keeps the record.
			await promote(t, entryId, 'Edited again');
			expect(await read(t, entryId)).toMatchObject({
				sourceType: 'curated',
				curatedFromSourceType: 'file',
				memberAccess: 'restricted',
			});
			const shown = await review(t, entryId);
			expect(shown.blocker).toBe('source_missing');
			await expect(
				t.mutation(api.knowledge.sharing.shareWithMembers, {
					entryId,
					fingerprint: shown.fingerprint,
				})
			).rejects.toThrow();
			expect((await read(t, entryId)).memberAccess).toBe('restricted');
			expect(await auditRows(t)).toEqual([]);
		});

		it('Team Inbox extraction with no message or thread stays unshareable', async () => {
			const t = await setup();
			const entryId = await seedEntry(t, {
				sourceType: 'agent_extracted',
				memberAccess: 'restricted',
			});
			await promote(t, entryId);
			expect((await read(t, entryId)).curatedFromSourceType).toBe('agent_extracted');
			expect((await review(t, entryId)).blocker).toBe('team_inbox');
		});

		it('a legacy curated answer stays unknown when re-saved', async () => {
			const t = await setup();
			const entryId = await seedEntry(t, {
				sourceType: 'curated',
				isAuthoritative: true,
				memberAccess: 'restricted',
			});
			await promote(t, entryId);
			expect((await read(t, entryId)).curatedFromSourceType).toBeUndefined();
			expect((await review(t, entryId)).blocker).toBe('source_missing');
		});

		it('a legacy curated answer whose source is an uploaded file can be shared', async () => {
			const t = await setup();
			const entryId = await seedEntry(t, {
				sourceType: 'curated',
				isAuthoritative: true,
				sourceId: await seedFile(t, { sourceType: 'upload' }),
				memberAccess: 'restricted',
			});
			expect((await read(t, entryId)).curatedFromSourceType).toBeUndefined();
			expect((await review(t, entryId)).blocker).toBeNull();
			await share(t, entryId);
			expect((await read(t, entryId)).memberAccess).toBe('members');
		});

		it('a manual entry made into a curated answer can be shared', async () => {
			const t = await setup();
			const entryId = await seedEntry(t, { sourceType: 'manual', memberAccess: 'restricted' });
			await promote(t, entryId);
			expect((await read(t, entryId)).curatedFromSourceType).toBe('manual');
			await share(t, entryId);
			expect((await read(t, entryId)).memberAccess).toBe('members');
		});

		it('a curated answer authored as one can be shared after 0069 restricted it', async () => {
			const t = await setup();
			const entryId = await t.mutation(api.knowledge.graph.createPolicyEntry, {
				title: 'Returns',
				content: 'Thirty days.',
			});
			if (!entryId) throw new Error('no entry');
			expect((await read(t, entryId)).curatedFromSourceType).toBe('curated');
			await runMigration(t);
			expect((await read(t, entryId)).memberAccess).toBe('restricted');
			await share(t, entryId);
			expect((await read(t, entryId)).memberAccess).toBe('members');
		});
	});

	it('refuses an entry members can already see', async () => {
		const t = await setup();
		const entryId = await seedEntry(t, { sourceType: 'manual', memberAccess: 'members' });
		const shown = await review(t, entryId);
		expect(shown.blocker).toBe('already_shared');
		await expect(
			t.mutation(api.knowledge.sharing.shareWithMembers, {
				entryId,
				fingerprint: shown.fingerprint,
			})
		).rejects.toThrow();
		expect(await auditRows(t)).toEqual([]);
	});

	it('waits for migration 0069 to reach the older entries', async () => {
		const t = await setup();
		const older = await seedEntry(t, { sourceType: 'manual', memberAccess: 'restricted' });
		// Written before the stamp existed: restricted, but not by a stamp yet.
		const unstamped = await seedEntry(t, { sourceType: 'file' });
		tick();
		// The walk starts; its pages have not run.
		await t.mutation(migration.run, {});
		tick();
		const newer = await seedEntry(t, { sourceType: 'manual', memberAccess: 'restricted' });

		expect((await review(t, older)).blocker).toBe('restriction_pending');
		expect((await review(t, unstamped)).blocker).toBe('restriction_pending');
		await expect(
			t.mutation(api.knowledge.sharing.shareWithMembers, {
				entryId: older,
				fingerprint: (await review(t, older)).fingerprint,
			})
		).rejects.toThrow();
		// Written after the walk started: the walk will not touch it.
		expect((await review(t, newer)).blocker).toBeNull();

		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await review(t, older)).blocker).toBeNull();
		expect((await review(t, unstamped)).blocker).toBe('source_missing');
		await share(t, older);
		expect((await read(t, older)).memberAccess).toBe('members');
	});

	it('refuses a share when the entry changed after its review', async () => {
		const t = await setup();
		const contactId = await t.run((ctx) =>
			ctx.db.insert('contacts', createTestContact() as Doc<'contacts'>)
		);
		const entryId = await seedEntry(t, {
			sourceType: 'manual',
			memberAccess: 'restricted',
			content: 'Reviewed text',
			tags: ['a'],
		});
		const changes: Array<Partial<Doc<'knowledgeEntries'>>> = [
			{ content: 'Reviewed text\nand the private fact a merge folded in' },
			{ tags: ['a', 'acme-acquisition'] },
			{ contactIds: [contactId] },
			{ title: 'Another title' },
		];
		for (const change of changes) {
			const { fingerprint } = await review(t, entryId);
			await t.run((ctx) => ctx.db.patch(entryId, change));
			await expect(
				t.mutation(api.knowledge.sharing.shareWithMembers, { entryId, fingerprint })
			).rejects.toThrow(/changed after you reviewed it/);
			expect((await read(t, entryId)).memberAccess).toBe('restricted');
		}
		expect(await auditRows(t)).toEqual([]);

		// A fresh review of the current entry shares it.
		await share(t, entryId);
		expect((await read(t, entryId)).memberAccess).toBe('members');
	});

	it('treats a missing entry as not found', async () => {
		const t = await setup();
		const entryId = await seedEntry(t, { sourceType: 'manual', memberAccess: 'restricted' });
		const { fingerprint } = await review(t, entryId);
		await t.run((ctx) => ctx.db.delete(entryId));
		expect(await t.query(api.knowledge.sharing.getShareReview, { entryId })).toBeNull();
		await expect(
			t.mutation(api.knowledge.sharing.shareWithMembers, { entryId, fingerprint })
		).rejects.toThrow(/not found/);
	});
});
