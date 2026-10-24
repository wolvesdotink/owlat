/**
 * Every recompute adapter of the derived-field registry
 * (`maintenance/derivedFields/adapters.ts`), checked through the sampler's
 * `checkParent` against a corrupted cache and against the cases where the
 * honest answer is to write nothing: a lifetime total above its rows, a cache a
 * rollup cron owns, a missing optional counter with no source rows, history
 * that aged out, an aggregate whose rebuild has not finished.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { AUDIT_LOG_RETENTION_MS } from '../lib/constants';
import { spendPeriodKeys } from '../lib/aiRouting/spendPeriods';
import { createTestCampaign, createTestTransactionalEmail } from './factories';

const modules = import.meta.glob('../**/*.*s');
type T = ReturnType<typeof convexTest>;

beforeEach(() => {
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
});

const check = (t: T, fieldId: string, parentId: string, now?: number) =>
	t.mutation(internal.maintenance.derivedFields.sampler.checkParent, {
		fieldId,
		parentId,
		...(now !== undefined ? { now } : {}),
	});

const DAY_MS = 24 * 60 * 60 * 1000;

describe('assistantConversationMessages', () => {
	async function seed(t: T, opts: { messages: number; messageCount: number; deletedAt?: number }) {
		return await t.run(async (ctx) => {
			const conversationId = await ctx.db.insert('aiConversations', {
				ownerId: 'user-1',
				title: 'New chat',
				createdAt: 1,
				updatedAt: 1,
				lastMessageAt: 1,
				messageCount: opts.messageCount,
				...(opts.deletedAt !== undefined ? { deletedAt: opts.deletedAt } : {}),
			});
			for (let i = 0; i < opts.messages; i++) {
				await ctx.db.insert('aiMessages', {
					conversationId,
					ownerId: 'user-1',
					role: i % 2 === 0 ? 'user' : 'assistant',
					text: 'hi',
					status: 'complete',
					createdAt: 10 + i,
				});
			}
			return conversationId;
		});
	}

	it('repairs the message count and leaves the activity stamp alone', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t, { messages: 4, messageCount: 2 });
		expect(await check(t, 'assistantConversationMessages', id)).toBe('repaired');
		expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
			messageCount: 4,
			lastMessageAt: 1,
		});
	});

	it('leaves a soft-deleted conversation frozen', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t, { messages: 4, messageCount: 2, deletedAt: 5 });
		expect(await check(t, 'assistantConversationMessages', id)).toBe('ineligible');
		expect((await t.run((ctx) => ctx.db.get(id)))?.messageCount).toBe(2);
	});
});

describe('transactionalTemplateSends (raise only)', () => {
	async function seed(t: T, sends: number, sendCount?: number) {
		return await t.run(async (ctx) => {
			const templateId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail(sendCount !== undefined ? { sendCount } : {})
			);
			for (let i = 0; i < sends; i++) {
				await ctx.db.insert('transactionalSends', {
					kind: 'transactional',
					transactionalEmailId: templateId,
					email: `r${i}@example.com`,
					status: 'queued',
					queuedAt: 1,
				});
			}
			return templateId;
		});
	}
	const sendCount = async (t: T, id: Id<'transactionalEmails'>) =>
		(await t.run((ctx) => ctx.db.get(id)))?.sendCount;

	it('raises an undercount, including one that was never written', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t, 2);
		expect(await check(t, 'transactionalTemplateSends', id)).toBe('repaired');
		expect(await sendCount(t, id)).toBe(2);
	});

	it('never lowers a lifetime total above its remaining rows', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t, 2, 10);
		expect(await check(t, 'transactionalTemplateSends', id)).toBe('not_repaired');
		expect(await sendCount(t, id)).toBe(10);
	});

	it('writes no zero for a template that was never sent', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t, 0);
		expect(await check(t, 'transactionalTemplateSends', id)).toBe('clean');
		expect(await sendCount(t, id)).toBeUndefined();
	});
});

describe('campaignSendStats', () => {
	async function seed(
		t: T,
		overrides: Record<string, unknown>,
		shards: Array<Record<string, number>>
	) {
		return await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign(overrides));
			let shardKey = 0;
			for (const counts of shards) {
				await ctx.db.insert('campaignStatShards', { campaignId, shardKey: shardKey++, ...counts });
			}
			return campaignId;
		});
	}

	it('repairs a campaign no rollup cron covers any more, with a fresh stamp', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t, { status: 'sent', sentAt: Date.now() - 60 * DAY_MS, statsSent: 1 }, [
			{ statsSent: 3, statsOpened: 1 },
			{ statsSent: 2 },
		]);
		expect(await check(t, 'campaignSendStats', id)).toBe('repaired');
		const campaign = await t.run((ctx) => ctx.db.get(id));
		expect(campaign).toMatchObject({ statsSent: 5, statsOpened: 1, statsUnsubscribed: 0 });
		expect(campaign?.statsUpdatedAt).toBeTypeOf('number');
	});

	it('leaves a campaign the rollup crons keep fresh: their lag is not drift', async () => {
		const t = convexTest(schema, modules);
		const sending = await seed(t, { status: 'sending', statsSent: 0 }, [{ statsSent: 4 }]);
		const recent = await seed(t, { status: 'sent', sentAt: Date.now() - DAY_MS }, [
			{ statsSent: 4 },
		]);
		expect(await check(t, 'campaignSendStats', sending)).toBe('ineligible');
		expect(await check(t, 'campaignSendStats', recent)).toBe('ineligible');
	});

	it('reads an absent counter as zero: a draft without shards is clean and untouched', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t, { status: 'draft' }, []);
		expect(await check(t, 'campaignSendStats', id)).toBe('clean');
		expect((await t.run((ctx) => ctx.db.get(id)))?.statsFailed).toBeUndefined();
	});
});

describe('pluginStorageQuota', () => {
	async function seed(
		t: T,
		entries: number[],
		usage: { entryCount: number; totalStoredBytes: number }
	) {
		return await t.run(async (ctx) => {
			for (const [i, storedBytes] of entries.entries()) {
				await ctx.db.insert('pluginStorageEntries', {
					organizationId: 'org-1',
					pluginId: 'alpha',
					key: `k${i}`,
					valueJson: '{}',
					storedBytes,
					createdAt: 1,
					updatedAt: 1,
				});
			}
			return await ctx.db.insert('pluginStorageUsage', {
				organizationId: 'org-1',
				pluginId: 'alpha',
				updatedAt: 1,
				...usage,
			});
		});
	}

	it('repairs the quota counters to the entries', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t, [10, 20], { entryCount: 5, totalStoredBytes: 7 });
		expect(await check(t, 'pluginStorageQuota', id)).toBe('repaired');
		expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
			entryCount: 2,
			totalStoredBytes: 30,
		});
	});

	it('removes a usage row whose entries are all gone, as the storage service does', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t, [], { entryCount: 1, totalStoredBytes: 9 });
		expect(await check(t, 'pluginStorageQuota', id)).toBe('repaired');
		expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
	});
});

describe('pluginLlmDailySpend', () => {
	async function seed(t: T, charged: number) {
		return await t.run(async (ctx) => {
			const base = {
				organizationId: 'org-1',
				pluginId: 'alpha',
				utcDay: '2026-10-20',
				actorUserId: 'user-1',
				tier: 'fast' as const,
				modelId: 'gpt-4o-mini',
				endpointProvenance: 'openai-native' as const,
				createdAt: 1,
			};
			// A pending hold counts its whole maximum, a failed call too, a
			// completed one its settled charge.
			await ctx.db.insert('pluginLlmReservations', {
				...base,
				reservationId: 'r1',
				reservedMicrousd: 300,
				status: 'pending',
			});
			await ctx.db.insert('pluginLlmReservations', {
				...base,
				reservationId: 'r2',
				reservedMicrousd: 300,
				status: 'failed',
				chargedMicrousd: 300,
			});
			await ctx.db.insert('pluginLlmReservations', {
				...base,
				reservationId: 'r3',
				reservedMicrousd: 300,
				status: 'completed',
				chargedMicrousd: 120,
				actualMicrousd: 40,
			});
			return await ctx.db.insert('pluginLlmDailyUsage', {
				organizationId: 'org-1',
				pluginId: 'alpha',
				utcDay: '2026-10-20',
				chargedMicrousd: charged,
				actualMicrousd: 40,
				admittedCallCount: 3,
				updatedAt: 1,
			});
		});
	}

	it('repairs the day to its reservations, pending holds included', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t, 100);
		expect(await check(t, 'pluginLlmDailySpend', id)).toBe('repaired');
		expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
			chargedMicrousd: 720,
			actualMicrousd: 40,
			admittedCallCount: 3,
		});
		expect(await check(t, 'pluginLlmDailySpend', id)).toBe('clean');
	});

	it('leaves a day near the end of the retention window alone', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t, 100);
		const late = Date.now() + AUDIT_LOG_RETENTION_MS - DAY_MS / 2;
		expect(await check(t, 'pluginLlmDailySpend', id, late)).toBe('ineligible');
		expect((await t.run((ctx) => ctx.db.get(id)))?.chargedMicrousd).toBe(100);
	});
});

describe('llmSpendBuckets', () => {
	async function seed(t: T, state: { status: 'complete' | 'rebuilding'; generation: number }) {
		return await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('llmSpendAggregateState', {
				status: state.status,
				generation: state.generation,
				rebuildCutoff: now,
				scannedCount: 0,
				updatedAt: now,
			});
			const row = {
				feature: 'assistant',
				promptTokens: 1,
				completionTokens: 1,
				totalTokens: 2,
				createdAt: now,
				spendGeneration: 1,
			};
			await ctx.db.insert('llmUsageEvents', { ...row, costUsd: 0, costMicrousd: 500 });
			await ctx.db.insert('llmUsageEvents', {
				...row,
				costUsd: 0,
				costMicrousd: 250,
				isEstimated: true,
			});
			// Another budget class: not this bucket's.
			await ctx.db.insert('llmUsageEvents', {
				...row,
				costUsd: 0,
				costMicrousd: 999,
				budgetClass: 'triage',
			});
			return await ctx.db.insert('llmSpendPeriods', {
				periodKind: 'day',
				periodKey: spendPeriodKeys(now).day,
				plane: 'language',
				budgetClass: 'standard',
				settledMicrousd: 100,
				estimatedMicrousd: 0,
				eventCount: 1,
				generation: 1,
				updatedAt: now,
			});
		});
	}

	it('repairs a bucket of a finished rebuild to its ledger rows', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t, { status: 'complete', generation: 1 });
		expect(await check(t, 'llmSpendBuckets', id)).toBe('repaired');
		expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
			settledMicrousd: 750,
			estimatedMicrousd: 250,
			eventCount: 2,
		});
	});

	it('writes nothing while a rebuild runs or for a bucket of an older generation', async () => {
		const t = convexTest(schema, modules);
		const rebuilding = await seed(t, { status: 'rebuilding', generation: 1 });
		expect(await check(t, 'llmSpendBuckets', rebuilding)).toBe('skipped');
		expect((await t.run((ctx) => ctx.db.get(rebuilding)))?.settledMicrousd).toBe(100);

		const t2 = convexTest(schema, modules);
		const stale = await seed(t2, { status: 'complete', generation: 2 });
		expect(await check(t2, 'llmSpendBuckets', stale)).toBe('skipped');
		expect((await t2.run((ctx) => ctx.db.get(stale)))?.settledMicrousd).toBe(100);
	});
});

describe('postboxOutboundState', () => {
	async function seed(t: T, outbound: unknown) {
		return await t.run(async (ctx) => {
			const now = Date.now();
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: 'user-1',
				organizationId: 'org-1',
				address: 'alice@example.com',
				domain: 'example.com',
				status: 'active' as const,
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});
			const folderId = await ctx.db.insert('mailFolders', {
				mailboxId,
				name: 'Sent',
				role: 'sent' as const,
				uidValidity: now,
				uidNext: 2,
				highestModseq: 1,
				totalCount: 1,
				unseenCount: 0,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
			const threadId = await ctx.db.insert('mailThreads', {
				mailboxId,
				normalizedSubject: 'hi',
				participants: ['alice@example.com'],
				messageCount: 1,
				unreadCount: 0,
				hasFlagged: false,
				hasAttachments: false,
				lastMessageAt: now,
				firstMessageAt: now,
				latestSnippet: 'hi',
				latestFromAddress: 'alice@example.com',
				latestSubject: 'hi',
				folderRoles: ['sent'],
				labelIds: [],
				createdAt: now,
				updatedAt: now,
			});
			const rawStorageId = await ctx.storage.store(new Blob(['raw']));
			return await ctx.db.insert('mailMessages', {
				mailboxId,
				folderId,
				uid: 1,
				modseq: 1,
				rfc822MessageId: '<test@example.com>',
				threadId,
				fromAddress: 'alice@example.com',
				toAddresses: ['bob@example.com', 'carol@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				subject: 'hi',
				normalizedSubject: 'hi',
				snippet: 'hi',
				rawStorageId,
				rawSize: 3,
				attachments: [],
				hasAttachments: false,
				flagSeen: true,
				flagFlagged: false,
				flagAnswered: false,
				flagDraft: false,
				flagDeleted: false,
				customFlags: [],
				labelIds: [],
				receivedAt: now,
				internalDate: now,
				...(outbound ? { outbound: outbound as never } : {}),
				createdAt: now,
				updatedAt: now,
			});
		});
	}

	it('repairs the aggregate state from the recipients and keeps them as they were', async () => {
		const t = convexTest(schema, modules);
		const recipients = [
			{ idx: 0, address: 'bob@example.com', mtaJobId: 'pb-x-0', state: 'sent' },
			{ idx: 1, address: 'carol@example.com', mtaJobId: 'pb-x-1', state: 'bounced' },
		];
		const id = await seed(t, { state: 'queued', recipients });
		expect(await check(t, 'postboxOutboundState', id)).toBe('repaired');
		expect((await t.run((ctx) => ctx.db.get(id)))?.outbound).toEqual({
			state: 'partial',
			recipients,
		});
	});

	it('passes over inbound mail, which has no outbound state', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t, undefined);
		expect(await check(t, 'postboxOutboundState', id)).toBe('ineligible');
	});
});
