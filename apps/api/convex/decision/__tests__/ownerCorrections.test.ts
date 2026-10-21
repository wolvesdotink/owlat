/**
 * Owner corrections invalidate decision data: overruling the
 * Team classifier ("needs a reply") or recategorizing a Postbox thread leaves
 * no sender-memory entry or artifact about that sender's mail reusable. And a
 * purged Postbox message takes its artifacts with it.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { createTestContact, createTestInboundMessage } from '../../__tests__/factories';
import {
	modules,
	seedFolder,
	seedMailbox,
	seedMessage,
} from '../../mail/__tests__/helpers.testlib';
import { senderDigest } from '../senderMemory';
import { deleteMessageRowAndBlobs } from '../../mail/messagePurge';

const session = vi.hoisted(() => ({
	userId: 'test-user',
	role: 'owner',
	activeOrganizationId: 'test-org',
}));
vi.mock('../../lib/sessionOrganization', async () => ({
	...(await vi.importActual<object>('../../lib/sessionOrganization')),
	requireAdminContext: vi.fn(async () => session),
	getMutationContext: vi.fn(async () => session),
	getBetterAuthSessionWithRole: vi.fn(async () => session),
}));

function memoryRow(
	scope: { scope: 'team_inbox' } | { scope: 'mailbox'; mailboxId: Id<'mailboxes'> },
	address: string
) {
	return {
		...scope,
		senderDigest: senderDigest(address),
		authBasis: 'dmarc_pass' as const,
		task: 'mail.category' as const,
		matchKind: 'exact' as const,
		matchKey: 'hash',
		policyVersion: 1,
		modelIdentity: 'typesafe/jev-1.13.0',
		outcome: '{}',
		outcomeVersion: 1,
		hitCount: 0,
		expiresAt: Date.now() + 60_000,
		createdAt: 1,
		updatedAt: 1,
	};
}

type ArtifactSubject =
	| { subjectKind: 'inbound_message'; inboundMessageId: Id<'inboundMessages'> }
	| { subjectKind: 'mail_message'; mailMessageId: Id<'mailMessages'>; mailboxId: Id<'mailboxes'> };

function artifactRow(subject: ArtifactSubject) {
	return {
		artifactKey: `k-${JSON.stringify(subject)}`,
		task: 'mail.category' as const,
		kind: 'advisory' as const,
		status: 'complete' as const,
		contentHash: 'hash',
		policyVersion: 1,
		expiresAt: Date.now() + 60_000,
		createdAt: 1,
		updatedAt: 1,
		...subject,
	};
}

beforeEach(() => vi.clearAllMocks());

describe('owner corrections', () => {
	it('overruling the Team classifier invalidates the sender’s memory and the message’s artifacts', async () => {
		const t = convexTest(schema, modules);
		const { inboundMessageId, otherSender } = await t.run(async (ctx) => {
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'ada@example.com' })
			);
			const threadId = await ctx.db.insert('conversationThreads', {
				subject: 'FYI',
				normalizedSubject: 'fyi',
				contactId,
				contactIdentifier: 'ada@example.com',
				status: 'open',
				messageCount: 1,
				lastMessageAt: Date.now(),
				firstMessageAt: Date.now(),
				createdAt: Date.now(),
			});
			const inboundMessageId = await ctx.db.insert(
				'inboundMessages',
				createTestInboundMessage({
					from: 'Ada <ada@example.com>',
					processingStatus: 'informational',
					contactId,
					threadId,
				})
			);
			await ctx.db.insert('senderMemory', memoryRow({ scope: 'team_inbox' }, 'ada@example.com'));
			const otherSender = await ctx.db.insert(
				'senderMemory',
				memoryRow({ scope: 'team_inbox' }, 'eve@example.com')
			);
			await ctx.db.insert(
				'decisionArtifacts',
				artifactRow({ subjectKind: 'inbound_message', inboundMessageId })
			);
			return { inboundMessageId, otherSender };
		});

		// The overrule schedules the Team walker's re-draft; it is not under test
		// here, so the clock is held and the job never fires.
		vi.useFakeTimers();
		try {
			await t.mutation(api.inbox.updates.requestReply, { inboundMessageId });
		} finally {
			vi.useRealTimers();
		}

		await t.run(async (ctx) => {
			const rows = await ctx.db.query('senderMemory').collect();
			const ada = rows.find((row) => row.senderDigest === senderDigest('ada@example.com'));
			expect(ada).toMatchObject({ invalidationReason: 'owner_correction' });
			expect((await ctx.db.get(otherSender))?.invalidatedAt).toBeUndefined();
			const [artifact] = await ctx.db.query('decisionArtifacts').collect();
			expect(artifact).toMatchObject({ invalidationReason: 'owner_correction' });
			expect((await ctx.db.get(inboundMessageId))?.decisionCorrectedAt).toEqual(expect.any(Number));
		});
	});

	it('recategorizing a Postbox thread invalidates the sender’s memory in that mailbox only', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, {
			userId: 'test-user',
			organizationId: 'test-org',
			address: 'me@example.com',
			domain: 'example.com',
		});
		await seedFolder(t, mailboxId, 'inbox');
		const messageId = await seedMessage(t, mailboxId, { fromAddress: 'news@shop.example' });
		const otherMailbox = await seedMailbox(t, { address: 'other@example.com' });
		const { threadId, elsewhere } = await t.run(async (ctx) => {
			const message = await ctx.db.get(messageId);
			await ctx.db.insert(
				'senderMemory',
				memoryRow({ scope: 'mailbox', mailboxId }, 'news@shop.example')
			);
			const elsewhere = await ctx.db.insert(
				'senderMemory',
				memoryRow({ scope: 'mailbox', mailboxId: otherMailbox }, 'news@shop.example')
			);
			await ctx.db.insert(
				'decisionArtifacts',
				artifactRow({ subjectKind: 'mail_message', mailMessageId: messageId, mailboxId })
			);
			return { threadId: message!.threadId, elsewhere };
		});

		await t.mutation(api.mail.category.recategorize, { threadId, label: 'newsletter' });

		await t.run(async (ctx) => {
			const rows = await ctx.db.query('senderMemory').collect();
			const here = rows.find((row) => row.mailboxId === mailboxId);
			expect(here).toMatchObject({ invalidationReason: 'owner_correction' });
			expect((await ctx.db.get(elsewhere))?.invalidatedAt).toBeUndefined();
			const [artifact] = await ctx.db.query('decisionArtifacts').collect();
			expect(artifact).toMatchObject({ invalidationReason: 'owner_correction' });
			expect((await ctx.db.get(messageId))?.decisionCorrectedAt).toEqual(expect.any(Number));
		});
	});
});

describe('purging a Postbox message', () => {
	it('deletes its decision artifacts and the sender memory learned from it', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { address: 'me@example.com' });
		await seedFolder(t, mailboxId, 'inbox');
		const messageId = await seedMessage(t, mailboxId);
		const keptId = await seedMessage(t, mailboxId, { subject: 'kept' });
		const purged = artifactRow({
			subjectKind: 'mail_message',
			mailMessageId: messageId,
			mailboxId,
		});
		const kept = artifactRow({ subjectKind: 'mail_message', mailMessageId: keptId, mailboxId });
		await t.run(async (ctx) => {
			await ctx.db.insert('decisionArtifacts', purged);
			await ctx.db.insert('decisionArtifacts', kept);
			await ctx.db.insert('senderMemory', {
				...memoryRow({ scope: 'mailbox', mailboxId }, 'someone@example.com'),
				sourceArtifactKey: purged.artifactKey,
				sourceMailMessageId: messageId,
			});
			await ctx.db.insert('senderMemory', {
				...memoryRow({ scope: 'mailbox', mailboxId }, 'other@example.com'),
				sourceArtifactKey: kept.artifactKey,
				sourceMailMessageId: keptId,
			});
			await deleteMessageRowAndBlobs(ctx, (await ctx.db.get(messageId))!);
		});
		const left = await t.run((ctx) => ctx.db.query('decisionArtifacts').collect());
		expect(left.map((row) => row.mailMessageId)).toEqual([keptId]);
		const learned = await t.run((ctx) => ctx.db.query('senderMemory').collect());
		expect(learned.map((row) => row.sourceMailMessageId)).toEqual([keptId]);
	});

	it('still finds the memory after retention deleted the artifact first', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { address: 'me@example.com' });
		await seedFolder(t, mailboxId, 'inbox');
		const messageId = await seedMessage(t, mailboxId);
		const artifact = {
			...artifactRow({ subjectKind: 'mail_message', mailMessageId: messageId, mailboxId }),
			expiresAt: Date.now() - 1,
		};
		await t.run(async (ctx) => {
			await ctx.db.insert('decisionArtifacts', artifact);
			await ctx.db.insert('senderMemory', {
				...memoryRow({ scope: 'mailbox', mailboxId }, 'someone@example.com'),
				sourceArtifactKey: artifact.artifactKey,
				sourceMailMessageId: messageId,
			});
		});
		await t.mutation(internal.maintenance.retention.sweepAiRoutingRecords, {});
		expect(await t.run((ctx) => ctx.db.query('decisionArtifacts').collect())).toEqual([]);
		expect(await t.run((ctx) => ctx.db.query('senderMemory').collect())).toHaveLength(1);
		await t.run(async (ctx) => {
			await deleteMessageRowAndBlobs(ctx, (await ctx.db.get(messageId))!);
		});
		expect(await t.run((ctx) => ctx.db.query('senderMemory').collect())).toEqual([]);
	});
});

describe('excluding a mailbox from hosted decisions', () => {
	it('sets the Team Inbox and a mailbox apart, audited, and writes nothing when unchanged', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { address: 'me@example.com' });
		await t.mutation(api.decision.exclusion.setHostedDecisionExclusion, {
			target: { kind: 'team_inbox' },
			isExcluded: true,
		});
		await t.mutation(api.decision.exclusion.setHostedDecisionExclusion, {
			target: { kind: 'mailbox', mailboxId },
			isExcluded: true,
		});
		await t.mutation(api.decision.exclusion.setHostedDecisionExclusion, {
			target: { kind: 'mailbox', mailboxId },
			isExcluded: true,
		});
		await t.run(async (ctx) => {
			expect((await ctx.db.query('agentConfig').first())?.isExcludedFromHostedDecisions).toBe(true);
			expect((await ctx.db.get(mailboxId))?.isExcludedFromHostedDecisions).toBe(true);
			const audits = await ctx.db.query('auditLogs').collect();
			expect(
				audits
					.filter((row) => row.action === 'ai_decision_exclusion.updated')
					.map((row) => [row.resourceId, row.details])
			).toEqual([
				['team_inbox', { target: 'team_inbox', isExcluded: true }],
				[mailboxId, { target: 'mailbox', isExcluded: true }],
			]);
		});
		await t.mutation(api.decision.exclusion.setHostedDecisionExclusion, {
			target: { kind: 'mailbox', mailboxId },
			isExcluded: false,
		});
		expect((await t.run((ctx) => ctx.db.get(mailboxId)))?.isExcludedFromHostedDecisions).toBe(
			false
		);
	});
});
