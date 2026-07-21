/**
 * Integration tests for the Postbox outbound lifecycle module.
 *
 * Covers per-recipient legal/illegal/terminal edges, the same-state
 * `recorded` outcome, aggregate-state re-derivation after every transition,
 * `transitionByMtaMessageId` parsing, and the `audit_log` effect.
 *
 * See docs/adr/0012-postbox-outbound-lifecycle-module.md.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { ActionCtx } from '../_generated/server';
import { readGmailVolumes } from '../delivery/complianceTelemetry';
import { dispatchInboundEvent } from '../webhooks/dispatcher';
import type { InboundEvent } from '../webhooks/types';

vi.mock('../lib/contactCountHelpers', async () => {
	const actual = await vi.importActual('../lib/contactCountHelpers');
	return {
		...actual,
		incrementContactCount: vi.fn().mockResolvedValue(undefined),
		decrementContactCount: vi.fn().mockResolvedValue(undefined),
		getCachedContactCount: vi.fn().mockResolvedValue(0),
		reconcileContactCount: vi.fn().mockResolvedValue(undefined),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
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

afterEach(() => {
	vi.useRealTimers();
});

type RecipientFixture = {
	address: string;
	state: 'queued' | 'sent' | 'bounced' | 'failed';
};

function dispatchEvent(t: ReturnType<typeof convexTest>, event: InboundEvent): Promise<void> {
	const actionCtx = {
		runMutation: (mutation: Parameters<ActionCtx['runMutation']>[0], args: unknown) =>
			t.mutation(mutation, args),
	} as unknown as ActionCtx;
	return dispatchInboundEvent(actionCtx, event);
}

async function refreshPendingGmailVolumes(t: ReturnType<typeof convexTest>): Promise<void> {
	const jobs = await t.run((ctx) => ctx.db.query('gmailDomainVolumeRollupJobs').take(16));
	for (const job of jobs) {
		await t.mutation(internal.delivery.complianceTelemetry.refreshGmailDomainVolume, {
			jobId: job._id,
			primaryDomain: job.primaryDomain,
		});
	}
}

/**
 * Seed a mailMessages row with N recipients all in the given initial state.
 * Returns the row id so tests can transition against it.
 */
async function seedMessage(
	t: ReturnType<typeof convexTest>,
	recipients: RecipientFixture[],
	aggregate: 'queued' | 'sent' | 'bounced' | 'failed' | 'partial' = 'queued'
): Promise<Id<'mailMessages'>> {
	let messageId!: Id<'mailMessages'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'test-user',
			organizationId: 'test-org',
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
			participants: ['alice@example.com', ...recipients.map((r) => r.address)],
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
		const storageId = await ctx.storage.store(new Blob(['raw'], { type: 'message/rfc822' }));
		messageId = await ctx.db.insert('mailMessages', {
			mailboxId,
			folderId,
			uid: 1,
			modseq: 1,
			rfc822MessageId: '<test@example.com>',
			threadId,
			fromAddress: 'alice@example.com',
			toAddresses: recipients.map((r) => r.address),
			ccAddresses: [],
			bccAddresses: [],
			subject: 'hi',
			normalizedSubject: 'hi',
			snippet: 'hi',
			rawStorageId: storageId,
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
			outbound: {
				state: aggregate,
				recipients: recipients.map((r, idx) => ({
					idx,
					address: r.address,
					mtaJobId: `pb-test-${idx}`,
					state: r.state,
				})),
			},
			createdAt: now,
			updatedAt: now,
		});
	});
	return messageId;
}

async function getRow(
	t: ReturnType<typeof convexTest>,
	id: Id<'mailMessages'>
): Promise<{
	aggregate: string;
	recipients: Array<{ idx: number; state: string }>;
}> {
	let result!: { aggregate: string; recipients: Array<{ idx: number; state: string }> };
	await t.run(async (ctx) => {
		const row = await ctx.db.get(id);
		const recipients = row!.outbound!.recipients as Array<{
			idx: number;
			state: 'queued' | 'sent' | 'bounced' | 'failed';
		}>;
		result = {
			aggregate: row!.outbound!.state,
			recipients: recipients.map((r) => ({
				idx: r.idx,
				state: r.state,
			})),
		};
	});
	return result;
}

// ============================================================
// Legal edges
// ============================================================

describe('postboxOutboundLifecycle.transition — legal edges', () => {
	it('queued → sent transitions one recipient and updates aggregate', async () => {
		const t = convexTest(schema, modules);
		const id = await seedMessage(t, [{ address: 'a@x.com', state: 'queued' }]);

		const outcome = await t.mutation(internal.mail.postboxOutboundLifecycle.transition, {
			mailMessageId: id,
			recipientIdx: 0,
			input: { to: 'sent', at: Date.now() },
		});

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.applied).toBe('transitioned');
			expect(outcome.from).toBe('queued');
			expect(outcome.to).toBe('sent');
			expect(outcome.aggregateBefore).toBe('queued');
			expect(outcome.aggregateAfter).toBe('sent');
		}

		const row = await getRow(t, id);
		expect(row.aggregate).toBe('sent');
		expect(row.recipients[0]!.state).toBe('sent');
	});

	it('queued → bounced transitions one recipient (synchronous reject)', async () => {
		const t = convexTest(schema, modules);
		const id = await seedMessage(t, [{ address: 'a@x.com', state: 'queued' }]);

		const outcome = await t.mutation(internal.mail.postboxOutboundLifecycle.transition, {
			mailMessageId: id,
			recipientIdx: 0,
			input: { to: 'bounced', at: Date.now(), bounceMessage: '550 No such user' },
		});

		expect(outcome.ok).toBe(true);

		const row = await getRow(t, id);
		expect(row.aggregate).toBe('bounced');
		expect(row.recipients[0]!.state).toBe('bounced');
	});

	it('queued → failed records pre-MTA error', async () => {
		const t = convexTest(schema, modules);
		const id = await seedMessage(t, [{ address: 'a@x.com', state: 'queued' }]);

		const outcome = await t.mutation(internal.mail.postboxOutboundLifecycle.transition, {
			mailMessageId: id,
			recipientIdx: 0,
			input: {
				to: 'failed',
				at: Date.now(),
				errorMessage: 'connection refused',
				errorCode: 'MTA_POST_NETWORK',
			},
		});

		expect(outcome.ok).toBe(true);

		const row = await getRow(t, id);
		expect(row.aggregate).toBe('failed');
		expect(row.recipients[0]!.state).toBe('failed');
	});

	it('sent → bounced supports async bounce', async () => {
		const t = convexTest(schema, modules);
		const id = await seedMessage(t, [{ address: 'a@x.com', state: 'sent' }], 'sent');

		const outcome = await t.mutation(internal.mail.postboxOutboundLifecycle.transition, {
			mailMessageId: id,
			recipientIdx: 0,
			input: { to: 'bounced', at: Date.now() },
		});

		expect(outcome.ok).toBe(true);
		const row = await getRow(t, id);
		expect(row.aggregate).toBe('bounced');
		expect(row.recipients[0]!.state).toBe('bounced');
	});
});

// ============================================================
// Illegal / terminal edges
// ============================================================

describe('postboxOutboundLifecycle.transition — refusals', () => {
	it('bounced → sent is refused as terminal', async () => {
		const t = convexTest(schema, modules);
		const id = await seedMessage(t, [{ address: 'a@x.com', state: 'bounced' }], 'bounced');

		const outcome = await t.mutation(internal.mail.postboxOutboundLifecycle.transition, {
			mailMessageId: id,
			recipientIdx: 0,
			input: { to: 'sent', at: Date.now() },
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('terminal');
	});

	it('failed → sent is refused as terminal', async () => {
		const t = convexTest(schema, modules);
		const id = await seedMessage(t, [{ address: 'a@x.com', state: 'failed' }], 'failed');

		const outcome = await t.mutation(internal.mail.postboxOutboundLifecycle.transition, {
			mailMessageId: id,
			recipientIdx: 0,
			input: { to: 'sent', at: Date.now() },
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('terminal');
	});

	it('sent → failed is refused as illegal_edge (not terminal — sent → bounced is legal)', async () => {
		const t = convexTest(schema, modules);
		const id = await seedMessage(t, [{ address: 'a@x.com', state: 'sent' }], 'sent');

		const outcome = await t.mutation(internal.mail.postboxOutboundLifecycle.transition, {
			mailMessageId: id,
			recipientIdx: 0,
			input: {
				to: 'failed',
				at: Date.now(),
				errorMessage: 'late failure',
			},
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('illegal_edge');
	});

	it('returns message_not_found for an unknown id', async () => {
		const t = convexTest(schema, modules);
		const id = await seedMessage(t, [{ address: 'a@x.com', state: 'queued' }]);
		// Delete the row to simulate a stale lookup.
		await t.run(async (ctx) => {
			await ctx.db.delete(id);
		});

		const outcome = await t.mutation(internal.mail.postboxOutboundLifecycle.transition, {
			mailMessageId: id,
			recipientIdx: 0,
			input: { to: 'sent', at: Date.now() },
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('message_not_found');
	});

	it('returns recipient_not_found for an out-of-range idx', async () => {
		const t = convexTest(schema, modules);
		const id = await seedMessage(t, [{ address: 'a@x.com', state: 'queued' }]);

		const outcome = await t.mutation(internal.mail.postboxOutboundLifecycle.transition, {
			mailMessageId: id,
			recipientIdx: 7,
			input: { to: 'sent', at: Date.now() },
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('recipient_not_found');
	});
});

// ============================================================
// Same-state (recorded) + aggregate re-derivation
// ============================================================

describe('postboxOutboundLifecycle.transition — recorded + aggregate', () => {
	it('sent → sent returns recorded (idempotent)', async () => {
		const t = convexTest(schema, modules);
		const id = await seedMessage(t, [{ address: 'a@x.com', state: 'sent' }], 'sent');

		const outcome = await t.mutation(internal.mail.postboxOutboundLifecycle.transition, {
			mailMessageId: id,
			recipientIdx: 0,
			input: { to: 'sent', at: Date.now() },
		});

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.applied).toBe('recorded');
			expect(outcome.aggregateAfter).toBe('sent');
		}
	});

	it('mixed outcomes produce partial aggregate', async () => {
		const t = convexTest(schema, modules);
		const id = await seedMessage(t, [
			{ address: 'a@x.com', state: 'queued' },
			{ address: 'b@x.com', state: 'queued' },
			{ address: 'c@x.com', state: 'queued' },
		]);

		// Recipient 0 succeeds
		await t.mutation(internal.mail.postboxOutboundLifecycle.transition, {
			mailMessageId: id,
			recipientIdx: 0,
			input: { to: 'sent', at: Date.now() },
		});
		// Recipient 1 bounces
		await t.mutation(internal.mail.postboxOutboundLifecycle.transition, {
			mailMessageId: id,
			recipientIdx: 1,
			input: { to: 'bounced', at: Date.now() },
		});
		// Recipient 2 still queued

		const row = await getRow(t, id);
		expect(row.aggregate).toBe('partial');
		expect(row.recipients.find((r) => r.idx === 0)?.state).toBe('sent');
		expect(row.recipients.find((r) => r.idx === 1)?.state).toBe('bounced');
		expect(row.recipients.find((r) => r.idx === 2)?.state).toBe('queued');
	});

	it('all recipients reach sent → aggregate sent', async () => {
		const t = convexTest(schema, modules);
		const id = await seedMessage(t, [
			{ address: 'a@x.com', state: 'queued' },
			{ address: 'b@x.com', state: 'queued' },
		]);

		await t.mutation(internal.mail.postboxOutboundLifecycle.transition, {
			mailMessageId: id,
			recipientIdx: 0,
			input: { to: 'sent', at: Date.now() },
		});
		await t.mutation(internal.mail.postboxOutboundLifecycle.transition, {
			mailMessageId: id,
			recipientIdx: 1,
			input: { to: 'sent', at: Date.now() },
		});

		const row = await getRow(t, id);
		expect(row.aggregate).toBe('sent');
	});
});

// ============================================================
// transitionByMtaMessageId — external-key path
// ============================================================

describe('postboxOutboundLifecycle.transitionByMtaMessageId', () => {
	it('parses pb-<id>-<idx> and transitions the matching recipient', async () => {
		const t = convexTest(schema, modules);
		const id = await seedMessage(t, [
			{ address: 'a@x.com', state: 'queued' },
			{ address: 'b@x.com', state: 'queued' },
		]);

		const outcome = await t.mutation(
			internal.mail.postboxOutboundLifecycle.transitionByMtaMessageId,
			{
				rawProviderMessageId: `pb-${id}-1`,
				input: { to: 'sent', at: Date.now() },
			}
		);

		expect(outcome.ok).toBe(true);
		const row = await getRow(t, id);
		expect(row.recipients.find((r) => r.idx === 1)?.state).toBe('sent');
		expect(row.recipients.find((r) => r.idx === 0)?.state).toBe('queued');
		expect(row.aggregate).toBe('partial');
	});

	it('returns unknown_mta_id_prefix for non-pb strings', async () => {
		const t = convexTest(schema, modules);

		const outcome = await t.mutation(
			internal.mail.postboxOutboundLifecycle.transitionByMtaMessageId,
			{
				rawProviderMessageId: 'resend-abc',
				input: { to: 'sent', at: Date.now() },
			}
		);

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('unknown_mta_id_prefix');
	});

	it('returns recipient_not_found for an out-of-range idx', async () => {
		const t = convexTest(schema, modules);
		const id = await seedMessage(t, [{ address: 'a@x.com', state: 'queued' }]);

		const outcome = await t.mutation(
			internal.mail.postboxOutboundLifecycle.transitionByMtaMessageId,
			{
				rawProviderMessageId: `pb-${id}-9`,
				input: { to: 'sent', at: Date.now() },
			}
		);

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('recipient_not_found');
	});
});

describe('postbox remote acceptance chronology', () => {
	const acceptedAt = 10_000;
	const terminalAt = acceptedAt + 1_000;
	const primaryDomain = 'postbox.example';

	function acceptance(
		messageId: Id<'mailMessages'>,
		at = acceptedAt
	): Extract<InboundEvent, { kind: 'email.delivered' }> {
		return {
			kind: 'email.delivered',
			providerMessageId: `pb-${messageId}-0`,
			at,
			destinationProvider: 'gmail',
			primarySendingDomain: primaryDomain,
		};
	}

	it.each([
		{ terminalKind: 'email.bounced' as const, expectedState: 'bounced' as const },
		{ terminalKind: 'email.failed' as const, expectedState: 'failed' as const },
	])(
		'attributes earlier acceptance after later $expectedState arrives first',
		async ({ terminalKind, expectedState }) => {
			vi.useFakeTimers();
			vi.setSystemTime(terminalAt);
			const t = convexTest(schema, modules);
			const id = await seedMessage(t, [{ address: 'a@gmail.com', state: 'queued' }]);
			const providerMessageId = `pb-${id}-0`;
			await dispatchEvent(
				t,
				terminalKind === 'email.bounced'
					? {
							kind: terminalKind,
							providerMessageId,
							at: terminalAt,
							bounceType: 'hard',
						}
					: {
							kind: terminalKind,
							providerMessageId,
							at: terminalAt,
							errorMessage: 'post-DATA timeout',
							errorCode: 'AMBIGUOUS_TIMEOUT',
						}
			);

			await dispatchEvent(t, acceptance(id));
			await dispatchEvent(t, acceptance(id));
			await refreshPendingGmailVolumes(t);

			await t.run(async (ctx) => {
				const message = await ctx.db.get(id);
				expect(message?.outbound?.recipients[0]).toMatchObject({
					state: expectedState,
					acceptedAt,
				});
			});
			expect((await t.run((ctx) => readGmailVolumes(ctx.db))).domains).toEqual([
				{ primaryDomain, delivered24h: 1 },
			]);
		}
	);

	it('keeps accepted evidence when acceptance arrives before a later bounce', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(terminalAt);
		const t = convexTest(schema, modules);
		const id = await seedMessage(t, [{ address: 'a@gmail.com', state: 'queued' }]);
		await dispatchEvent(t, acceptance(id));
		await dispatchEvent(t, {
			kind: 'email.bounced',
			providerMessageId: `pb-${id}-0`,
			at: terminalAt,
			bounceType: 'hard',
		});
		await dispatchEvent(t, acceptance(id));
		await refreshPendingGmailVolumes(t);

		await t.run(async (ctx) => {
			const message = await ctx.db.get(id);
			expect(message?.outbound?.recipients[0]).toMatchObject({
				state: 'bounced',
				acceptedAt,
			});
		});
		expect((await t.run((ctx) => readGmailVolumes(ctx.db))).domains).toEqual([
			{ primaryDomain, delivered24h: 1 },
		]);
	});

	it('rejects acceptance that truly follows a terminal event', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(terminalAt);
		const t = convexTest(schema, modules);
		const id = await seedMessage(t, [{ address: 'a@gmail.com', state: 'queued' }]);
		await dispatchEvent(t, {
			kind: 'email.bounced',
			providerMessageId: `pb-${id}-0`,
			at: acceptedAt,
			bounceType: 'hard',
		});
		await dispatchEvent(t, acceptance(id, terminalAt));

		await t.run(async (ctx) => {
			const message = await ctx.db.get(id);
			expect(message?.outbound?.recipients[0]?.acceptedAt).toBeUndefined();
		});
		expect((await t.run((ctx) => readGmailVolumes(ctx.db))).domains).toEqual([]);
	});

	it('suppresses Gmail telemetry for malformed, missing, and deleted recipients', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(terminalAt);
		const t = convexTest(schema, modules);
		const id = await seedMessage(t, [{ address: 'a@gmail.com', state: 'queued' }]);
		const malformedTerminalId = await seedMessage(
			t,
			[{ address: 'b@gmail.com', state: 'bounced' }],
			'bounced'
		);
		await dispatchEvent(t, acceptance(malformedTerminalId));
		await dispatchEvent(t, {
			...acceptance(id),
			providerMessageId: `pb-${id}-9`,
		});
		await dispatchEvent(t, {
			...acceptance(id),
			providerMessageId: 'pb-malformed',
		});
		await t.run((ctx) => ctx.db.delete(id));
		await dispatchEvent(t, acceptance(id));

		expect((await t.run((ctx) => readGmailVolumes(ctx.db))).domains).toEqual([]);
	});
});

// ============================================================
// Audit log effect
// ============================================================

describe('postboxOutboundLifecycle — audit_log effect', () => {
	it('writes one audit row per transition', async () => {
		const t = convexTest(schema, modules);
		const id = await seedMessage(t, [{ address: 'a@x.com', state: 'queued' }]);

		await t.mutation(internal.mail.postboxOutboundLifecycle.transition, {
			mailMessageId: id,
			recipientIdx: 0,
			input: { to: 'sent', at: 12345 },
		});

		await t.run(async (ctx) => {
			const logs = await ctx.db.query('auditLogs').collect();
			const ours = logs.filter((l) => l.action === 'postbox_outbound_transition');
			expect(ours).toHaveLength(1);
			expect(ours[0]!.resource).toBe('mail_message');
			expect(ours[0]!.resourceId).toBe(id);
			expect(ours[0]!.details?.['recipientIdx']).toBe(0);
			expect(ours[0]!.details?.['from']).toBe('queued');
			expect(ours[0]!.details?.['to']).toBe('sent');
			expect(ours[0]!.details?.['aggregateBefore']).toBe('queued');
			expect(ours[0]!.details?.['aggregateAfter']).toBe('sent');
		});
	});

	it('writes audit row even on recorded (idempotent) transitions', async () => {
		const t = convexTest(schema, modules);
		const id = await seedMessage(t, [{ address: 'a@x.com', state: 'sent' }], 'sent');

		await t.mutation(internal.mail.postboxOutboundLifecycle.transition, {
			mailMessageId: id,
			recipientIdx: 0,
			input: { to: 'sent', at: Date.now() },
		});

		await t.run(async (ctx) => {
			const logs = await ctx.db.query('auditLogs').collect();
			expect(logs.some((l) => l.action === 'postbox_outbound_transition')).toBe(true);
		});
	});

	it('does not write audit row when transition is refused', async () => {
		const t = convexTest(schema, modules);
		const id = await seedMessage(t, [{ address: 'a@x.com', state: 'bounced' }], 'bounced');

		const outcome = await t.mutation(internal.mail.postboxOutboundLifecycle.transition, {
			mailMessageId: id,
			recipientIdx: 0,
			input: { to: 'sent', at: Date.now() },
		});
		expect(outcome.ok).toBe(false);

		await t.run(async (ctx) => {
			const logs = await ctx.db.query('auditLogs').collect();
			expect(logs.filter((l) => l.action === 'postbox_outbound_transition')).toHaveLength(0);
		});
	});
});
