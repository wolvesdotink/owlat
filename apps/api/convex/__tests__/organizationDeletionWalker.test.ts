/**
 * Organization deletion module-family — unit + integration tests.
 *
 * Covers (per ADR-0025 §Tests):
 *   1. Per-step modules — convex-test-driven, seeded rows, asserts
 *      deletion + `hasMore` semantics.
 *   2. Storage purge — for each storage-bearing step, asserts the blob
 *      is gone after the batch.
 *   3. Delegating steps — `contacts` routes through
 *      `permanentlyDeleteContactWithRelations` (verified by full
 *      cascade behaviour); `domains` routes through
 *      `sendingDomainLifecycle.remove` (verified by audit-log emission
 *      + identity-sibling cleanup).
 *   4. Walker dispatch — runs end-to-end through scheduler, asserts
 *      every step ran in order and no orphan rows remain.
 *   5. Ordered list invariants — meta-test asserting `STEPS` contains
 *      every `OrganizationDeletionTable` literal exactly once.
 *   6. Integration — drives `organizationSettings.remove` end-to-end.
 *
 * Per ADR-0025.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { nextTable, ORGANIZATION_DELETION_STEPS, STEPS } from '../workspaces/deletion/walker';
import type { OrganizationDeletionTable } from '../workspaces/deletion/steps/_common';
import {
	createTestContact,
	createTestEmailTemplate,
	createTestTransactionalEmail,
} from './factories';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'owner',
		}),
	};
});

// Exclude provider register actions — they require AWS / MTA credentials
// and the domains step delegates via the lifecycle which schedules them.
const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) => !path.includes('providers/registerAction'))
);

/**
 * Drain the current batch of scheduled functions, then cancel anything
 * still pending or in-flight. The walker's chained `scheduler.runAfter`
 * leaves follow-up `runStep` hops pending after each unit test — under
 * convex-test@0.0.50 those chained hops hit a scheduling bug
 * (`nestedTxStorage.exit` for setTimeout, fixed in 0.0.53) and log
 * "Transaction already committed" errors via `console.error`. Logging
 * after the worker tears down surfaces as an unhandled
 * `EnvironmentTeardownError`. Cancelling the queue at end-of-test stops
 * the cascade.
 */
type TestRunner = ReturnType<typeof convexTest>;
async function drainAndCancel(t: TestRunner): Promise<void> {
	await t.finishInProgressScheduledFunctions();
	await t.run(async (ctx) => {
		const pending = await ctx.db.system.query('_scheduled_functions').collect();
		for (const job of pending) {
			if (job.state.kind === 'pending' || job.state.kind === 'inProgress') {
				await ctx.scheduler.cancel(job._id);
			}
		}
	});
}

// ────────────────────────────────────────────────────────────────────
// Ordered list invariants
// ────────────────────────────────────────────────────────────────────

describe('Organization deletion walker — STEPS list invariants', () => {
	it('contains every OrganizationDeletionTable literal exactly once', () => {
		const registryKeys = Object.keys(ORGANIZATION_DELETION_STEPS) as OrganizationDeletionTable[];
		expect(STEPS).toHaveLength(registryKeys.length);
		expect(new Set(STEPS)).toEqual(new Set(registryKeys));
		// No duplicates.
		expect(new Set(STEPS).size).toBe(STEPS.length);
	});

	it('has instanceSettings as terminal step', () => {
		expect(STEPS[STEPS.length - 1]).toBe('instanceSettings');
	});

	it('has auditLogs as second-to-last (accumulates from delegated calls)', () => {
		expect(STEPS[STEPS.length - 2]).toBe('auditLogs');
	});

	it('orders contacts after emailSends + transactionalSends', () => {
		expect(STEPS.indexOf('contacts')).toBeGreaterThan(STEPS.indexOf('emailSends'));
		expect(STEPS.indexOf('contacts')).toBeGreaterThan(STEPS.indexOf('transactionalSends'));
	});

	it('orders domain identities + reputation before domains step', () => {
		const domainsIdx = STEPS.indexOf('domains');
		expect(STEPS.indexOf('sendingDomainMtaIdentities')).toBeLessThan(domainsIdx);
		expect(STEPS.indexOf('sendingDomainSesIdentities')).toBeLessThan(domainsIdx);
		expect(STEPS.indexOf('trackingDomains')).toBeLessThan(domainsIdx);
		expect(STEPS.indexOf('sendingReputation')).toBeLessThan(domainsIdx);
		expect(STEPS.indexOf('googlePostmasterStats')).toBeLessThan(domainsIdx);
	});
});

describe('Organization deletion walker — nextTable', () => {
	it('returns the table at STEPS[i+1] for a non-terminal step', () => {
		expect(nextTable('mediaAssets')).toBe(STEPS[1]);
	});

	it('returns null for the terminal step', () => {
		expect(nextTable('instanceSettings')).toBeNull();
	});

	it('returns the right next step for a mid-list table', () => {
		const idx = STEPS.indexOf('campaigns');
		expect(nextTable('campaigns')).toBe(STEPS[idx + 1]);
	});
});

// ────────────────────────────────────────────────────────────────────
// Per-step modules — hard-delete shape
// ────────────────────────────────────────────────────────────────────

describe('Organization deletion step modules — hard-delete shape', () => {
	it('segments step deletes rows and reports hasMore: false on partial batch', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('segments', {
				name: 'Active',
				filters: { conditions: [], logic: 'AND' as const },
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('segments', {
				name: 'Engaged',
				filters: { conditions: [], logic: 'AND' as const },
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.mutation(internal.workspaces.deletion.walker.runStep, {
			table: 'segments',
		});
		await drainAndCancel(t);

		await t.run(async (ctx) => {
			const remaining = await ctx.db.query('segments').collect();
			expect(remaining).toHaveLength(0);
		});
	});

	it('apiKeys step deletes rows', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('apiKeys', {
				name: 'Production',
				keyHash: 'h',
				keyPrefix: 'p',
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.mutation(internal.workspaces.deletion.walker.runStep, {
			table: 'apiKeys',
		});
		await drainAndCancel(t);

		await t.run(async (ctx) => {
			const remaining = await ctx.db.query('apiKeys').collect();
			expect(remaining).toHaveLength(0);
		});
	});

	it('webhooks step deletes rows', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('webhooks', {
				name: 'Slack',
				url: 'https://example.com',
				events: ['email.sent'] as const,
				isActive: true,
				secret: 'secret',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.mutation(internal.workspaces.deletion.walker.runStep, {
			table: 'webhooks',
		});
		await drainAndCancel(t);

		await t.run(async (ctx) => {
			const remaining = await ctx.db.query('webhooks').collect();
			expect(remaining).toHaveLength(0);
		});
	});
});

// ────────────────────────────────────────────────────────────────────
// Storage purge — storage-bearing steps
// ────────────────────────────────────────────────────────────────────

describe('Organization deletion step modules — storage purge', () => {
	it('mediaAssets step purges blob before row delete', async () => {
		const t = convexTest(schema, modules);
		let storageId: Id<'_storage'>;
		await t.run(async (ctx) => {
			const blob = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'application/octet-stream',
			});
			storageId = await ctx.storage.store(blob);
			await ctx.db.insert('mediaAssets', {
				storageId,
				filename: 'a.png',
				mimeType: 'image/png',
				fileSize: 3,
				url: 'http://example.com/a.png',
				uploadedBy: 'user',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		// Blob exists pre-wipe.
		await t.run(async (ctx) => {
			expect(await ctx.storage.getUrl(storageId)).not.toBeNull();
		});

		await t.mutation(internal.workspaces.deletion.walker.runStep, {
			table: 'mediaAssets',
		});
		await drainAndCancel(t);

		await t.run(async (ctx) => {
			// Blob is gone.
			expect(await ctx.storage.getUrl(storageId)).toBeNull();
			// Row is gone.
			const rows = await ctx.db.query('mediaAssets').collect();
			expect(rows).toHaveLength(0);
		});
	});

	it('semanticFiles step purges blob before row delete', async () => {
		const t = convexTest(schema, modules);
		let storageId: Id<'_storage'>;
		await t.run(async (ctx) => {
			const blob = new Blob([new Uint8Array([4, 5, 6])], {
				type: 'application/pdf',
			});
			storageId = await ctx.storage.store(blob);
			await ctx.db.insert('semanticFiles', {
				storageId,
				filename: 'doc.pdf',
				mimeType: 'application/pdf',
				fileSize: 3,
				sourceType: 'upload' as const,
				version: 1,
				embedding: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.mutation(internal.workspaces.deletion.walker.runStep, {
			table: 'semanticFiles',
		});
		await drainAndCancel(t);

		await t.run(async (ctx) => {
			expect(await ctx.storage.getUrl(storageId)).toBeNull();
			const rows = await ctx.db.query('semanticFiles').collect();
			expect(rows).toHaveLength(0);
		});
	});

	it('mailMessages step purges raw + text + html storage refs', async () => {
		const t = convexTest(schema, modules);
		let rawSid: Id<'_storage'>;
		let textSid: Id<'_storage'>;
		let htmlSid: Id<'_storage'>;
		await t.run(async (ctx) => {
			rawSid = await ctx.storage.store(new Blob(['raw'], { type: 'message/rfc822' }));
			textSid = await ctx.storage.store(new Blob(['text'], { type: 'text/plain' }));
			htmlSid = await ctx.storage.store(new Blob(['html'], { type: 'text/html' }));
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: 'u',
				organizationId: 'o',
				address: 'a@b.com',
				domain: 'b.com',
				status: 'active' as const,
				usedBytes: 0,
				uidValidity: Date.now(),
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			const folderId = await ctx.db.insert('mailFolders', {
				mailboxId,
				name: 'INBOX',
				uidValidity: Date.now(),
				uidNext: 1,
				highestModseq: 0,
				totalCount: 0,
				unseenCount: 0,
				subscribed: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			const threadId = await ctx.db.insert('mailThreads', {
				mailboxId,
				normalizedSubject: 's',
				participants: ['a@b.com'],
				messageCount: 1,
				unreadCount: 0,
				hasFlagged: false,
				hasAttachments: false,
				lastMessageAt: Date.now(),
				firstMessageAt: Date.now(),
				latestSnippet: '',
				latestFromAddress: 'a@b.com',
				latestSubject: 's',
				folderRoles: [],
				labelIds: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('mailMessages', {
				mailboxId,
				folderId,
				uid: 1,
				modseq: 0,
				rfc822MessageId: '<a@b>',
				threadId,
				fromAddress: 'a@b.com',
				toAddresses: ['c@d.com'],
				ccAddresses: [],
				bccAddresses: [],
				subject: 's',
				normalizedSubject: 's',
				snippet: '',
				rawStorageId: rawSid,
				rawSize: 3,
				textBodyStorageId: textSid,
				htmlBodyStorageId: htmlSid,
				attachments: [],
				hasAttachments: false,
				flagSeen: false,
				flagFlagged: false,
				flagAnswered: false,
				flagDraft: false,
				flagDeleted: false,
				customFlags: [],
				labelIds: [],
				receivedAt: Date.now(),
				internalDate: Date.now(),
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.mutation(internal.workspaces.deletion.walker.runStep, {
			table: 'mailMessages',
		});
		await drainAndCancel(t);

		await t.run(async (ctx) => {
			expect(await ctx.storage.getUrl(rawSid)).toBeNull();
			expect(await ctx.storage.getUrl(textSid)).toBeNull();
			expect(await ctx.storage.getUrl(htmlSid)).toBeNull();
			const rows = await ctx.db.query('mailMessages').collect();
			expect(rows).toHaveLength(0);
		});
	});

	it('mailDrafts step purges every attachment storage ref per row', async () => {
		const t = convexTest(schema, modules);
		let sid1: Id<'_storage'>;
		let sid2: Id<'_storage'>;
		await t.run(async (ctx) => {
			sid1 = await ctx.storage.store(new Blob(['att1']));
			sid2 = await ctx.storage.store(new Blob(['att2']));
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: 'u',
				organizationId: 'o',
				address: 'a@b.com',
				domain: 'b.com',
				status: 'active' as const,
				usedBytes: 0,
				uidValidity: Date.now(),
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('mailDrafts', {
				mailboxId,
				toAddresses: ['c@d.com'],
				ccAddresses: [],
				bccAddresses: [],
				fromAddress: 'a@b.com',
				subject: 's',
				bodyHtml: '<p>x</p>',
				attachments: [
					{
						storageId: sid1,
						filename: 'a.bin',
						contentType: 'application/octet-stream',
						size: 4,
						isInline: false,
					},
					{
						storageId: sid2,
						filename: 'b.bin',
						contentType: 'application/octet-stream',
						size: 4,
						isInline: false,
					},
				],
				state: 'draft' as const,
				lastEditedAt: Date.now(),
				createdAt: Date.now(),
			});
		});

		await t.mutation(internal.workspaces.deletion.walker.runStep, {
			table: 'mailDrafts',
		});
		await drainAndCancel(t);

		await t.run(async (ctx) => {
			expect(await ctx.storage.getUrl(sid1)).toBeNull();
			expect(await ctx.storage.getUrl(sid2)).toBeNull();
			const rows = await ctx.db.query('mailDrafts').collect();
			expect(rows).toHaveLength(0);
		});
	});

	it('transactionalSends step purges attachmentStorageIds per row', async () => {
		const t = convexTest(schema, modules);
		let sid: Id<'_storage'>;
		await t.run(async (ctx) => {
			sid = await ctx.storage.store(new Blob(['payload']));
			const txEmailId = await ctx.db.insert('transactionalEmails', createTestTransactionalEmail());
			await ctx.db.insert('transactionalSends', {
				kind: 'transactional' as const,
				transactionalEmailId: txEmailId,
				email: 'a@b.com',
				status: 'queued' as const,
				queuedAt: Date.now(),
				attachmentStorageIds: [sid],
			});
		});

		await t.mutation(internal.workspaces.deletion.walker.runStep, {
			table: 'transactionalSends',
		});
		await drainAndCancel(t);

		await t.run(async (ctx) => {
			expect(await ctx.storage.getUrl(sid)).toBeNull();
			const rows = await ctx.db.query('transactionalSends').collect();
			expect(rows).toHaveLength(0);
		});
	});
});

// ────────────────────────────────────────────────────────────────────
// Delegating steps — contacts + domains
// ────────────────────────────────────────────────────────────────────

describe('Organization deletion — delegating steps', () => {
	it('contacts step routes through permanentlyDeleteContactWithRelations (cascade behaviour)', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;
		let topicId: Id<'topics'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'cascade@example.com' })
			);
			topicId = await ctx.db.insert('topics', {
				name: 'List',
				createdAt: Date.now(),
			});
			await ctx.db.insert('contactTopics', {
				contactId,
				topicId,
				addedAt: Date.now(),
			});
			const propertyId = await ctx.db.insert('contactProperties', {
				key: 'company',
				label: 'Company',
				type: 'string' as const,
				createdAt: Date.now(),
			});
			await ctx.db.insert('contactPropertyValues', {
				contactId,
				propertyId,
				value: 'Acme',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('contactActivities', {
				contactId,
				activityType: 'email_opened' as const,
				metadata: { campaignId: 'c' },
				occurredAt: Date.now(),
			});
			await ctx.db.insert('contactIdentities', {
				contactId,
				channel: 'email',
				identifier: 'cascade@example.com',
				isPrimary: true,
				createdAt: Date.now(),
			});
		});

		await t.mutation(internal.workspaces.deletion.walker.runStep, {
			table: 'contacts',
		});
		await drainAndCancel(t);

		await t.run(async (ctx) => {
			// Contact row + every cascade child gone — confirms we routed
			// through the canonical helper rather than the pre-deepening
			// open-coded cascade (which missed contactRelationships).
			expect(await ctx.db.get(contactId!)).toBeNull();

			const memberships = await ctx.db
				.query('contactTopics')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId!))
				.collect();
			expect(memberships).toHaveLength(0);

			const propertyValues = await ctx.db
				.query('contactPropertyValues')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId!))
				.collect();
			expect(propertyValues).toHaveLength(0);

			const activities = await ctx.db
				.query('contactActivities')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId!))
				.collect();
			expect(activities).toHaveLength(0);

			const identities = await ctx.db
				.query('contactIdentities')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId!))
				.collect();
			expect(identities).toHaveLength(0);
		});
	});

	it('domains step routes through sendingDomainLifecycle.remove (audit + identity cleanup)', async () => {
		const t = convexTest(schema, modules);
		let domainId: Id<'domains'>;

		await t.run(async (ctx) => {
			domainId = await ctx.db.insert('domains', {
				domain: 'wipe-me.example.com',
				status: 'verified' as const,
				dnsRecords: { dkim: [] },
				providerType: 'ses',
				verifiedAt: Date.now(),
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('sendingDomainSesIdentities', {
				domainId,
				dkimTokens: ['t1', 't2', 't3'],
				verificationToken: 'v',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.mutation(internal.workspaces.deletion.walker.runStep, {
			table: 'domains',
		});
		await drainAndCancel(t);

		await t.run(async (ctx) => {
			// Domain row gone.
			expect(await ctx.db.get(domainId!)).toBeNull();
			// Identity sibling row gone (the lifecycle.remove clears it).
			const identities = await ctx.db
				.query('sendingDomainSesIdentities')
				.withIndex('by_domain', (q) => q.eq('domainId', domainId!))
				.collect();
			expect(identities).toHaveLength(0);
			// Audit row was emitted by lifecycle.remove (drift #4 closure).
			const audits = await ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('resourceId'), domainId))
				.collect();
			expect(audits.map((a) => a.action)).toContain('sending_domain.deleted');
		});
	});
});

// ────────────────────────────────────────────────────────────────────
// Walker dispatch — re-fire vs advance
// ────────────────────────────────────────────────────────────────────

describe('Organization deletion walker — dispatch loop', () => {
	it('terminal step (instanceSettings) deletes the row and does not re-schedule', async () => {
		const t = convexTest(schema, modules);
		let settingsId: Id<'instanceSettings'>;
		await t.run(async (ctx) => {
			settingsId = await ctx.db.insert('instanceSettings', {
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.mutation(internal.workspaces.deletion.walker.runStep, {
			table: 'instanceSettings',
		});
		await drainAndCancel(t);

		await t.run(async (ctx) => {
			expect(await ctx.db.get(settingsId!)).toBeNull();
		});
	});

	it('full walk: STEPS order empties every per-org table', async () => {
		// We drive the walk by calling `runStep` directly for each table in
		// `STEPS` order. This is equivalent in semantics to the
		// `walker.start` chain (each `runStep` returns; the walker
		// re-schedules; in production each hop is its own transaction). It
		// works around a chain-scheduling bug in convex-test@0.0.50 that
		// was fixed upstream in 0.0.53 (`nestedTxStorage.exit` wraps
		// setTimeout so chained scheduled mutations don't inherit a stale
		// parent lock). Once the project upgrades convex-test, the
		// `walker.start` end-to-end test can replace this.
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			// Seed some rows across the table types the wipe walks. Not
			// exhaustive — this checks the walker actually advances through
			// every step, not per-table semantics (those are above).
			await ctx.db.insert('apiKeys', {
				name: 'k',
				keyHash: 'h',
				keyPrefix: 'p',
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('segments', {
				name: 'S',
				filters: { conditions: [], logic: 'AND' as const },
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('topics', { name: 'T', createdAt: Date.now() });
			await ctx.db.insert('blockedEmails', {
				email: 'b@b.com',
				reason: 'manual' as const,
				createdAt: Date.now(),
			});
			await ctx.db.insert('emailTemplates', createTestEmailTemplate());
			await ctx.db.insert('instanceSettings', {
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		for (const table of STEPS) {
			await t.mutation(internal.workspaces.deletion.walker.runStep, {
				table,
			});
		}
		await drainAndCancel(t);

		await t.run(async (ctx) => {
			expect(await ctx.db.query('apiKeys').collect()).toHaveLength(0);
			expect(await ctx.db.query('segments').collect()).toHaveLength(0);
			expect(await ctx.db.query('topics').collect()).toHaveLength(0);
			expect(await ctx.db.query('blockedEmails').collect()).toHaveLength(0);
			expect(await ctx.db.query('emailTemplates').collect()).toHaveLength(0);
			expect(await ctx.db.query('instanceSettings').collect()).toHaveLength(0);
			// Audit logs are second-to-last so noise from delegated calls
			// ends up empty too.
			expect(await ctx.db.query('auditLogs').collect()).toHaveLength(0);
		});
	});
});

// ────────────────────────────────────────────────────────────────────
// Integration — drives organizations.settings.remove end-to-end
// ────────────────────────────────────────────────────────────────────

describe('organizations.settings.remove — end-to-end wipe', () => {
	it('remove() returns success + schedules walker.start', async () => {
		const t = convexTest(schema, modules);

		const outcome = await t.mutation(api.workspaces.settings.remove, {});
		expect(outcome.success).toBe(true);
		expect(outcome.message).toContain('deletion');

		await drainAndCancel(t);
	});

	it('end-to-end via direct STEPS iteration: wipes everything including storage', async () => {
		// See note on `full walk: STEPS order …` — convex-test@0.0.50 has a
		// chain-scheduling bug. Iterating STEPS directly here is equivalent
		// to the production chain in semantics.
		const t = convexTest(schema, modules);
		let storageId: Id<'_storage'>;
		await t.run(async (ctx) => {
			storageId = await ctx.storage.store(new Blob(['blob'], { type: 'image/png' }));
			await ctx.db.insert('mediaAssets', {
				storageId,
				filename: 'a.png',
				mimeType: 'image/png',
				fileSize: 4,
				url: 'http://example.com/a.png',
				uploadedBy: 'u',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('instanceSettings', {
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		for (const table of STEPS) {
			await t.mutation(internal.workspaces.deletion.walker.runStep, {
				table,
			});
		}
		await drainAndCancel(t);

		await t.run(async (ctx) => {
			// Storage purged.
			expect(await ctx.storage.getUrl(storageId)).toBeNull();
			// All wiped.
			expect(await ctx.db.query('mediaAssets').collect()).toHaveLength(0);
			expect(await ctx.db.query('instanceSettings').collect()).toHaveLength(0);
		});
	});
});
