/**
 * Tests for the Send completion (module) per ADR-0006.
 *
 * `completeSend` is the workpool `onComplete` callback — it translates a
 * worker result into a Send lifecycle transition (`sent` on success,
 * `failed` on error) and records the provider-attempt outcome against
 * providerHealth. These tests cover the translation per SendRef kind ×
 * outcome, plus provider-health side effects.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, it, expect } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import {
	createTestCampaign,
	createTestContact,
	createTestEmailSend,
	createTestTransactionalEmail,
} from './factories';
import type { Id } from '../_generated/dataModel';
import type { WorkId } from '@convex-dev/workpool';

const modules = import.meta.glob('../**/*.*s');

const NOW = 1_700_000_000_000;
const testWorkId = 'test-work-id' as WorkId;

// Build the workpool onComplete `result` payload for a successful / failed
// worker run (mirrors the shape `sendSingleEmail` surfaces on completion).
const workerSuccess = (providerMessageId: string) => ({
	kind: 'success' as const,
	returnValue: { success: true, providerMessageId },
});
const workerFailure = (error: string) => ({ kind: 'failed' as const, error });

afterEach(async () => {
	await new Promise((resolve) => setTimeout(resolve, 25));
});

async function setupCampaignSend(
	t: ReturnType<typeof convexTest>
): Promise<Id<'emailSends'>> {
	let sendId: Id<'emailSends'>;
	await t.run(async (ctx) => {
		const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
		const contactId = await ctx.db.insert('contacts', createTestContact());
		sendId = await ctx.db.insert(
			'emailSends',
			createTestEmailSend({ campaignId, contactId, status: 'queued' })
		);
	});
	return sendId!;
}

async function setupTransactionalSend(
	t: ReturnType<typeof convexTest>
): Promise<Id<'transactionalSends'>> {
	let txSendId: Id<'transactionalSends'>;
	await t.run(async (ctx) => {
		const txEmailId = await ctx.db.insert(
			'transactionalEmails',
			createTestTransactionalEmail()
		);
		txSendId = await ctx.db.insert('transactionalSends', {
			kind: 'transactional' as const,
			transactionalEmailId: txEmailId,
			email: 'tx@example.com',
			status: 'queued' as const,
			queuedAt: Date.now(),
		});
	});
	return txSendId!;
}

// ============================================================================
// Campaign Sends
// ============================================================================

describe('completeSend — campaign Sends', () => {
	it('result.success → transitions queued to sent', async () => {
		const t = convexTest(schema, modules);
		const sendId = await setupCampaignSend(t);

		await t.mutation(internal.delivery.sendCompletion.completeSend, {
			workId: testWorkId,
			result: {
				kind: 'success',
				returnValue: {
					success: true,
					providerMessageId: 'campaign-msg-1',
					providerType: 'mta',
					sendLatencyMs: 42,
				},
			},
			context: {
				sendRef: { kind: 'campaign' as const, id: sendId },
			},
		});

		await t.run(async (ctx) => {
			const send = await ctx.db.get(sendId);
			expect(send?.status).toBe('sent');
			expect(send?.providerMessageId).toBe('campaign-msg-1');
			expect(send?.providerType).toBe('mta');
			expect(send?.sentAt).toBeDefined();
		});
	});

	it('error string → transitions queued to failed with WORKPOOL_FAILED', async () => {
		const t = convexTest(schema, modules);
		const sendId = await setupCampaignSend(t);

		await t.mutation(internal.delivery.sendCompletion.completeSend, {
			workId: testWorkId,
			result: { kind: 'failed', error: 'connect ETIMEDOUT' },
			context: {
				sendRef: { kind: 'campaign' as const, id: sendId },
			},
		});

		await t.run(async (ctx) => {
			const send = await ctx.db.get(sendId);
			expect(send?.status).toBe('failed');
			expect(send?.errorMessage).toBe('connect ETIMEDOUT');
			expect(send?.errorCode).toBe('WORKPOOL_FAILED');
		});
	});

	it('success but missing providerMessageId is treated as failure', async () => {
		const t = convexTest(schema, modules);
		const sendId = await setupCampaignSend(t);

		await t.mutation(internal.delivery.sendCompletion.completeSend, {
			workId: testWorkId,
			result: { kind: 'success', returnValue: { success: true } }, // no providerMessageId
			context: {
				sendRef: { kind: 'campaign' as const, id: sendId },
			},
		});

		await t.run(async (ctx) => {
			const send = await ctx.db.get(sendId);
			expect(send?.status).toBe('failed');
			expect(send?.errorCode).toBe('WORKPOOL_FAILED');
		});
	});

	it('falls back to "Unknown error" when no error string is provided', async () => {
		const t = convexTest(schema, modules);
		const sendId = await setupCampaignSend(t);

		await t.mutation(internal.delivery.sendCompletion.completeSend, {
			workId: testWorkId,
			// failed with an empty error string → handler falls back
			result: { kind: 'failed', error: '' },
			context: {
				sendRef: { kind: 'campaign' as const, id: sendId },
			},
		});

		await t.run(async (ctx) => {
			const send = await ctx.db.get(sendId);
			expect(send?.status).toBe('failed');
			expect(send?.errorMessage).toBe('Unknown error');
		});
	});
});

// ============================================================================
// Transactional Sends
// ============================================================================

describe('completeSend — transactional Sends', () => {
	it('result.success → transitions queued to sent', async () => {
		const t = convexTest(schema, modules);
		const txSendId = await setupTransactionalSend(t);

		await t.mutation(internal.delivery.sendCompletion.completeSend, {
			workId: testWorkId,
			result: {
				kind: 'success',
				returnValue: {
					success: true,
					providerMessageId: 'tx-msg-1',
					providerType: 'resend',
					sendLatencyMs: 88,
				},
			},
			context: {
				sendRef: { kind: 'transactional' as const, id: txSendId },
			},
		});

		await t.run(async (ctx) => {
			const send = await ctx.db.get(txSendId);
			expect(send?.status).toBe('sent');
			expect(send?.providerMessageId).toBe('tx-msg-1');
			expect(send?.providerType).toBe('resend');
			expect(send?.sentAt).toBeDefined();
		});
	});

	it('error string → transitions queued to failed (failed rows persist post-α)', async () => {
		const t = convexTest(schema, modules);
		const txSendId = await setupTransactionalSend(t);

		await t.mutation(internal.delivery.sendCompletion.completeSend, {
			workId: testWorkId,
			result: { kind: 'failed', error: 'rate limited' },
			context: {
				sendRef: { kind: 'transactional' as const, id: txSendId },
			},
		});

		await t.run(async (ctx) => {
			const send = await ctx.db.get(txSendId);
			expect(send?.status).toBe('failed');
			expect(send?.errorMessage).toBe('rate limited');
			expect(send?.errorCode).toBe('WORKPOOL_FAILED');
		});
	});
});

// ============================================================================
// Provider health is NOT recorded here
//
// Per ADR-0020, provider health recording moved upstream to the **Send dispatch
// (helper)** in `lib/sendProviders/dispatch.ts`. Every send producer routes
// through the helper so health is recorded uniformly; Send completion's only
// job is the Send lifecycle transition. These regression tests guarantee the
// move stays moved — completeSend must never write to providerHealth, even
// when `providerType` is set in the result.
// ============================================================================

describe('completeSend — does NOT write providerHealth (ADR-0020 regression)', () => {
	it('does not record a row on success even when providerType is set', async () => {
		const t = convexTest(schema, modules);
		const sendId = await setupCampaignSend(t);

		await t.mutation(internal.delivery.sendCompletion.completeSend, {
			workId: testWorkId,
			result: {
				kind: 'success',
				returnValue: {
					success: true,
					providerMessageId: 'p-1',
					providerType: 'mta',
					sendLatencyMs: 120,
				},
			},
			context: {
				sendRef: { kind: 'campaign' as const, id: sendId },
			},
		});

		await t.run(async (ctx) => {
			// bounded: providerHealth has one row per provider kind (3 max)
			const records = await ctx.db.query('providerHealth').collect();
			expect(records).toHaveLength(0);
		});
	});

	it('does not record a row on failure', async () => {
		const t = convexTest(schema, modules);
		const sendId = await setupCampaignSend(t);

		await t.mutation(internal.delivery.sendCompletion.completeSend, {
			workId: testWorkId,
			result: { kind: 'failed', error: 'auth failure' },
			context: {
				sendRef: { kind: 'campaign' as const, id: sendId },
			},
		});

		await t.run(async (ctx) => {
			// bounded: providerHealth has one row per provider kind (3 max)
			const records = await ctx.db.query('providerHealth').collect();
			expect(records).toHaveLength(0);
		});
	});

	it('does not record a row when providerType is undefined', async () => {
		const t = convexTest(schema, modules);
		const sendId = await setupCampaignSend(t);

		await t.mutation(internal.delivery.sendCompletion.completeSend, {
			workId: testWorkId,
			result: {
				kind: 'success',
				returnValue: {
					success: true,
					providerMessageId: 'p-noprov',
					// no providerType
				},
			},
			context: {
				sendRef: { kind: 'campaign' as const, id: sendId },
			},
		});

		await t.run(async (ctx) => {
			// bounded: providerHealth has one row per provider kind (3 max)
			const records = await ctx.db.query('providerHealth').collect();
			expect(records).toHaveLength(0);
		});
	});

	// ── agent_reply reconciliation ──────────────────────────────────────────
	// An `agent_reply` Send carries the inbound message it answers; completeSend
	// drives that inbound message to sent/failed once the worker outcome lands
	// (replacing the old optimistic transition at dispatch time in
	// agent/agentPipeline.ts:sendApprovedReply).
	describe('agent_reply reconciliation', () => {
		async function seedAgentReply(t: ReturnType<typeof convexTest>): Promise<{
			sendId: Id<'transactionalSends'>;
			inboundMessageId: Id<'inboundMessages'>;
		}> {
			return await t.run(async (ctx) => {
				const inboundMessageId = await ctx.db.insert('inboundMessages', {
					to: 'support@example.com',
					from: 'Customer <customer@example.com>',
					subject: 'Hi',
					textBody: 'Hi',
					messageId: '<orig@example.com>',
					processingStatus: 'approved',
					draftResponse: 'Answer',
					receivedAt: NOW,
				});
				const sendId = await ctx.db.insert('transactionalSends', {
					kind: 'agent_reply' as const,
					email: 'customer@example.com',
					status: 'queued',
					queuedAt: NOW,
					inboundMessageId,
					subject: 'Re: Hi',
				});
				return { sendId, inboundMessageId };
			});
		}

		it('drives the inbound message to sent on agent_reply worker success', async () => {
			const t = convexTest(schema, modules);
			const { sendId, inboundMessageId } = await seedAgentReply(t);

			await t.mutation(internal.delivery.sendCompletion.completeSend, {
				result: workerSuccess('pm-agent'),
				context: { sendRef: { kind: 'transactional', id: sendId } },
				workId: testWorkId,
			});

			const send = await t.run(async (ctx) => ctx.db.get(sendId));
			expect(send?.status).toBe('sent');
			const inbound = await t.run(async (ctx) => ctx.db.get(inboundMessageId));
			expect(inbound?.processingStatus).toBe('sent');
		});

		it('drives the inbound message to failed on agent_reply worker failure', async () => {
			const t = convexTest(schema, modules);
			const { sendId, inboundMessageId } = await seedAgentReply(t);

			await t.mutation(internal.delivery.sendCompletion.completeSend, {
				result: workerFailure('SMTP 550'),
				context: { sendRef: { kind: 'transactional', id: sendId } },
				workId: testWorkId,
			});

			const send = await t.run(async (ctx) => ctx.db.get(sendId));
			expect(send?.status).toBe('failed');
			const inbound = await t.run(async (ctx) => ctx.db.get(inboundMessageId));
			expect(inbound?.processingStatus).toBe('failed');
		});

		// ── unified-timeline mirror (confirmed agent reply → unifiedMessages) ──
		// A seed that carries the thread + contact the outbound mirror needs.
		async function seedThreadedAgentReply(
			t: ReturnType<typeof convexTest>,
		): Promise<{
			sendId: Id<'transactionalSends'>;
			threadId: Id<'conversationThreads'>;
			contactId: Id<'contacts'>;
		}> {
			return await t.run(async (ctx) => {
				const contactId = await ctx.db.insert('contacts', createTestContact());
				const threadId = await ctx.db.insert('conversationThreads', {
					subject: 'Hi',
					normalizedSubject: 'hi',
					contactId,
					contactIdentifier: 'customer@example.com',
					status: 'open',
					messageCount: 1,
					lastMessageAt: NOW,
					firstMessageAt: NOW,
					createdAt: NOW,
				});
				const inboundMessageId = await ctx.db.insert('inboundMessages', {
					to: 'support@example.com',
					from: 'Customer <customer@example.com>',
					subject: 'Hi',
					textBody: 'Hi',
					messageId: '<orig@example.com>',
					threadId,
					contactId,
					processingStatus: 'approved',
					draftResponse: 'Thanks for reaching out!',
					receivedAt: NOW,
				});
				const sendId = await ctx.db.insert('transactionalSends', {
					kind: 'agent_reply' as const,
					email: 'customer@example.com',
					status: 'queued',
					queuedAt: NOW,
					inboundMessageId,
					contactId,
					subject: 'Re: Hi',
				});
				return { sendId, threadId, contactId };
			});
		}

		it('mirrors a confirmed agent reply into unifiedMessages as an email-outbound row', async () => {
			const t = convexTest(schema, modules);
			const { sendId, threadId, contactId } = await seedThreadedAgentReply(t);

			await t.mutation(internal.delivery.sendCompletion.completeSend, {
				result: workerSuccess('pm-agent-out'),
				context: { sendRef: { kind: 'transactional', id: sendId } },
				workId: testWorkId,
			});

			await t.run(async (ctx) => {
				const rows = await ctx.db
					.query('unifiedMessages')
					.withIndex('by_contact', (q) => q.eq('contactId', contactId))
					.collect();
				expect(rows).toHaveLength(1);
				const row = rows[0]!;
				expect(row.channel).toBe('email');
				expect(row.direction).toBe('outbound');
				expect(row.status).toBe('sent');
				expect(row.threadId).toBe(threadId);
				expect(row.externalMessageId).toBe('pm-agent-out');
				const content = JSON.parse(row.content);
				expect(content.text).toBe('Thanks for reaching out!');
				expect(content.subject).toBe('Re: Hi');
			});
		});

		it('does NOT mirror an outbound row when the agent reply send fails', async () => {
			const t = convexTest(schema, modules);
			const { sendId, contactId } = await seedThreadedAgentReply(t);

			await t.mutation(internal.delivery.sendCompletion.completeSend, {
				result: workerFailure('SMTP 550'),
				context: { sendRef: { kind: 'transactional', id: sendId } },
				workId: testWorkId,
			});

			await t.run(async (ctx) => {
				const rows = await ctx.db
					.query('unifiedMessages')
					.withIndex('by_contact', (q) => q.eq('contactId', contactId))
					.collect();
				expect(rows).toHaveLength(0);
			});
		});

		it('is idempotent — a re-fired onComplete does not duplicate the outbound row', async () => {
			const t = convexTest(schema, modules);
			const { sendId, contactId } = await seedThreadedAgentReply(t);

			const completion = {
				result: workerSuccess('pm-agent-dup'),
				context: { sendRef: { kind: 'transactional' as const, id: sendId } },
				workId: testWorkId,
			};
			await t.mutation(internal.delivery.sendCompletion.completeSend, completion);
			// Workpool re-fires the same onComplete.
			await t.mutation(internal.delivery.sendCompletion.completeSend, completion);

			await t.run(async (ctx) => {
				const rows = await ctx.db
					.query('unifiedMessages')
					.withIndex('by_contact', (q) => q.eq('contactId', contactId))
					.collect();
				expect(rows).toHaveLength(1);
			});
		});
	});
});
