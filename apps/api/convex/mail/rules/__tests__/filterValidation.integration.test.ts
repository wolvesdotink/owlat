/**
 * Resolved-action validation at every filter save boundary:
 * plain-language, Fix and AI rules are restrict-only, never file into Trash,
 * Spam, Sent or Drafts, wait 1–720 hours, never match headers and, with an AI
 * condition, never stop processing. Manual filters keep today's set, minus the
 * arrival actions they cannot run. Every bypass through update, import or a
 * retroactive run is refused.
 */

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import type { Doc, Id } from '../../../_generated/dataModel';
import { api, internal } from '../../../_generated/api';
import { modules } from '../../__tests__/helpers.testlib';
import { validateFilterForSave, type FilterForSave } from '../../filterValidation';
import {
	seedFilter,
	seedLabel,
	seedPersonalMailbox,
	seedUserFolder,
	type T,
} from './rules.testlib';

const sessionMocks = vi.hoisted(() => ({ userId: 'user-A' }));

vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	const session = async () => ({
		userId: sessionMocks.userId,
		role: 'owner' as const,
		activeOrganizationId: 'org-1',
	});
	return {
		...actual,
		requireOrgMember: vi.fn(session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(session),
		getBetterAuthSessionWithRole: vi.fn(session),
	};
});

beforeEach(() => {
	sessionMocks.userId = 'user-A';
});

type Action = Doc<'mailFilters'>['actions'][number];
const FROM_SHOP = [{ field: 'from' as const, op: 'contains' as const, value: 'shop.example' }];

async function check(t: T, mailboxId: Id<'mailboxes'>, filter: Partial<FilterForSave>) {
	return await t.run(async (ctx) => {
		try {
			await validateFilterForSave(ctx, mailboxId, {
				origin: 'plain_language',
				conditions: FROM_SHOP,
				actions: [{ type: 'markRead' }],
				stopProcessing: false,
				...filter,
			});
			return 'ok';
		} catch (error) {
			return error instanceof Error ? error.message : 'error';
		}
	});
}

describe('hook filters (plain language, Fix, AI)', () => {
	it('accept every restrict-only action', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId, folders } = await seedPersonalMailbox(t);
		const labelId = await seedLabel(t, mailboxId);
		const actions: Action[] = [
			{ type: 'addLabel', labelId },
			{ type: 'moveToFolder', folderId: folders.archive },
			{ type: 'markRead' },
			{ type: 'markFlagged' },
			{ type: 'pinToSection', sectionName: 'Bills' },
			{ type: 'sendToDigest' },
			{ type: 'placeInUpdates' },
			{ type: 'placeInNeedsMe' },
			{ type: 'archiveAfter', hours: 720 },
			{ type: 'notify' },
		];
		expect(await check(t, mailboxId, { actions })).toBe('ok');
	});

	it.each(['forward', 'delete', 'discard'] as const)('refuse %s', async (type) => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		const action: Action = type === 'forward' ? { type, forwardTo: 'x@example.com' } : { type };
		expect(await check(t, mailboxId, { actions: [action] })).toMatch(/cannot use the action/);
		expect(
			await check(t, mailboxId, { origin: 'fix', actions: [action] }),
			'a Fix rule too'
		).toMatch(/cannot use the action/);
		expect(
			await check(t, mailboxId, {
				origin: undefined,
				aiCondition: { question: 'Invoice?' },
				actions: [action],
			}),
			'a manual-origin rule with an AI condition too'
		).toMatch(/cannot use the action/);
	});

	it.each(['trash', 'spam', 'sent'] as const)('refuse a move into %s', async (role) => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId, folders } = await seedPersonalMailbox(t);
		expect(
			await check(t, mailboxId, { actions: [{ type: 'moveToFolder', folderId: folders[role] }] })
		).toMatch(/cannot file mail into that folder/);
	});

	it('refuse a role-less provider Junk folder and another mailbox’s folder', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		const junk = await seedUserFolder(t, mailboxId, 'Junk E-mail');
		expect(
			await check(t, mailboxId, { actions: [{ type: 'moveToFolder', folderId: junk }] })
		).toMatch(/cannot file mail into that folder/);
		const other = await t.run(async (ctx) => {
			const now = Date.now();
			const otherMailbox = await ctx.db.insert('mailboxes', {
				userId: 'user-B',
				organizationId: 'org-1',
				address: 'b@owlat.test',
				domain: 'owlat.test',
				status: 'active',
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			} as Omit<Doc<'mailboxes'>, '_id' | '_creationTime'>);
			return otherMailbox;
		});
		const foreign = await seedUserFolder(t, other, 'Finance');
		expect(
			await check(t, mailboxId, { actions: [{ type: 'moveToFolder', folderId: foreign }] })
		).toMatch(/unknown folder/);
	});

	it.each([0, 721, 1.5, undefined])('refuse archiveAfter %s hours', async (hours) => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		expect(
			await check(t, mailboxId, {
				actions: [{ type: 'archiveAfter', ...(hours !== undefined ? { hours } : {}) }],
			})
		).toMatch(/whole number of hours/);
	});

	it('refuse header conditions', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		expect(
			await check(t, mailboxId, {
				conditions: [{ field: 'header', headerName: 'List-Id', op: 'contains', value: 'x' }],
			})
		).toMatch(/cannot match on headers/);
	});

	it('refuse stopProcessing with an AI condition, and allow an empty deterministic part', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		expect(
			await check(t, mailboxId, { aiCondition: { question: 'Invoice?' }, stopProcessing: true })
		).toMatch(/cannot stop later rules/);
		expect(
			await check(t, mailboxId, { aiCondition: { question: 'Invoice?' }, conditions: [] })
		).toBe('ok');
		expect(await check(t, mailboxId, { conditions: [] })).toMatch(/At least one condition/);
	});
});

describe('the save boundaries', () => {
	it('create keeps manual filters to today’s actions', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		await expect(
			t.mutation(api.mail.filters.create, {
				mailboxId,
				name: 'digest',
				conditions: FROM_SHOP,
				actions: [{ type: 'sendToDigest' }],
			})
		).rejects.toThrow(/needs a plain-language rule/);
		await expect(
			t.mutation(api.mail.filters.create, {
				mailboxId,
				name: 'forward',
				conditions: FROM_SHOP,
				actions: [{ type: 'forward', forwardTo: 'x@example.com' }],
			})
		).resolves.toBeDefined();
	});

	it('update checks the stored origin and AI condition, and bumps the revision', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId, folders } = await seedPersonalMailbox(t);
		const plain = await seedFilter(t, mailboxId);
		await expect(
			t.mutation(api.mail.filters.update, {
				filterId: plain,
				actions: [{ type: 'delete' }],
			})
		).rejects.toThrow(/cannot use the action/);
		await expect(
			t.mutation(api.mail.filters.update, {
				filterId: plain,
				actions: [{ type: 'moveToFolder', folderId: folders.trash }],
			})
		).rejects.toThrow(/cannot file mail/);
		const ai = await seedFilter(t, mailboxId, {
			aiCondition: { question: 'Invoice?', revision: 0 },
		});
		await expect(
			t.mutation(api.mail.filters.update, { filterId: ai, stopProcessing: true })
		).rejects.toThrow(/cannot stop later rules/);
		await t.mutation(api.mail.filters.update, { filterId: ai, aiQuestion: 'A bill?' });
		const row = (await t.run(async (ctx) => await ctx.db.get(ai)))!;
		expect(row.revision).toBe(1);
		expect(row.aiCondition).toEqual({ question: 'A bill?', revision: 1 });
		// A toggle changes nothing the check reads and keeps the revision.
		await t.mutation(api.mail.filters.update, { filterId: ai, isEnabled: false });
		expect((await t.run(async (ctx) => await ctx.db.get(ai)))!.revision).toBe(1);
	});

	it('a retroactive run refuses an AI rule and stops one that became AI', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		const ai = await seedFilter(t, mailboxId, {
			aiCondition: { question: 'Invoice?', revision: 0 },
		});
		await expect(t.mutation(api.mail.filterRun.start, { filterId: ai })).rejects.toThrow(
			/runs on new mail only/
		);
		const plain = await seedFilter(t, mailboxId);
		await t.mutation(api.mail.filterRun.start, { filterId: plain });
		await t.run(
			async (ctx) =>
				await ctx.db.patch(plain, { aiCondition: { question: 'Invoice?', revision: 0 } })
		);
		await t.mutation(internal.mail.filterRun.runBatch, { filterId: plain });
		const job = await t.run(
			async (ctx) =>
				await ctx.db
					.query('mailFilterRunJobs')
					.withIndex('by_filter', (q) => q.eq('filterId', plain))
					.first()
		);
		expect(job?.status).toBe('cancelled');
		expect(job?.scannedCount).toBe(0);
	});
});
