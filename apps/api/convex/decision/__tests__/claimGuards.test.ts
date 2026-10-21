/**
 * What the claim and completion mutations check atomically: a deleted
 * message or mailbox is never claimed or completed, a
 * corrected message is never judged or learned from, and an excluded mailbox
 * never reaches a hosted endpoint. Plus the ingestion-time DMARC check that
 * invalidates sender memory whatever the bundles' switches say.
 */

import { convexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { beforeEach, describe, expect, it } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import {
	createTestContact,
	createTestInboundMessage,
	enableFeatures,
} from '../../__tests__/factories';
import { expectScheduledFailure } from '../../__tests__/helpers/scheduledFailures';
import {
	modules,
	seedFolder,
	seedMailbox,
	seedMessage,
} from '../../mail/__tests__/helpers.testlib';
import { senderDigest } from '../senderMemory';
import { insertDeliveredMessage } from '../../mail/deliveryPipeline/insert';

type T = TestConvex<typeof schema>;

/** A test deployment with the gates today's classifiers honour switched on. */
async function newT(): Promise<T> {
	const t = convexTest(schema, modules);
	await enableFeatures(t, ['ai.agent', 'ai']);
	await seedPolicy(t);
	return t;
}

/** The routing policy the claims below plan under: the category bundle in shadow. */
async function seedPolicy(t: T): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('aiRoutingPolicy', {
			categoryDisplayBundle: 'shadow',
			shadowCapUsd: 1,
			policyVersion: 1,
			updatedAt: 1,
			updatedBy: 'admin-1',
		});
	});
}

const PROVENANCE = {
	provider: 'typesafe' as const,
	modelUsed: 'jev-1.13.0',
	questionSetId: 'mail.message.team',
	questionSetVersion: 1,
};

async function teamMessage(t: T, over: Record<string, unknown> = {}) {
	return t.run(async (ctx) => {
		const contactId = await ctx.db.insert(
			'contacts',
			createTestContact({ email: 'ada@example.com' })
		);
		const threadId = await ctx.db.insert('conversationThreads', {
			subject: 'Hi',
			normalizedSubject: 'hi',
			contactId,
			contactIdentifier: 'ada@example.com',
			status: 'open',
			messageCount: 1,
			lastMessageAt: Date.now(),
			firstMessageAt: Date.now(),
			createdAt: Date.now(),
		});
		return ctx.db.insert(
			'inboundMessages',
			createTestInboundMessage({
				from: 'ada@example.com',
				dmarcResult: 'pass',
				contactId,
				threadId,
				...over,
			})
		);
	});
}

function claimArgs(
	subject:
		| { inboundMessageId: Id<'inboundMessages'> }
		| { mailMessageId: Id<'mailMessages'>; mailboxId: Id<'mailboxes'> },
	endpoint: {
		rung: 'decision' | 'language';
		isLocal: boolean;
		isDecisionPlaneOn?: boolean;
		configVersion?: string;
	} = { rung: 'language', isLocal: false }
) {
	return {
		artifactKey: `k-${JSON.stringify(subject)}`,
		task: 'mail.category' as const,
		kind: 'shadow' as const,
		subjectKind:
			'inboundMessageId' in subject ? ('inbound_message' as const) : ('mail_message' as const),
		...subject,
		contentHash: 'hash',
		policyVersion: 1,
		endpoint: { isDecisionPlaneOn: false, ...endpoint },
	};
}

function completeArgs(artifactKey: string, leaseExpiresAt: number) {
	return {
		artifactKey,
		leaseExpiresAt,
		status: 'complete' as const,
		labels: { category: 'support' },
		answers: '{}',
		provenance: PROVENANCE,
		calibration: { isAdapterCalibrated: true },
		contextVersion: 'typesafe||',
		memoryKey: 'fingerprint',
	};
}

/** A stored provider config naming TypeSafe, with no key stored. */
function typesafeWithoutKey() {
	return {
		languageProviderKind: 'openai' as const,
		modelFast: 'fast',
		modelCapable: 'capable',
		embeddingProviderKind: 'local' as const,
		embeddingModelVersion: 1,
		decisionProviderKind: 'typesafe' as const,
		updatedAt: Date.now(),
	};
}

const rows = (t: T) => t.run((ctx) => ctx.db.query('decisionArtifacts').collect());
const memory = (t: T) => t.run((ctx) => ctx.db.query('senderMemory').collect());

describe('claim and completion guards', () => {
	it('never claims a Team message deleted after its evidence was read (F7)', async () => {
		const t = await newT();
		const inboundMessageId = await teamMessage(t);
		await t.run((ctx) => ctx.db.delete(inboundMessageId));
		const claim = await t.mutation(
			internal.decision.artifacts.claim,
			claimArgs({ inboundMessageId })
		);
		expect(claim).toEqual({ outcome: 'gone' });
		expect(await rows(t)).toEqual([]);
	});

	it('never claims Postbox mail whose message or mailbox is gone (F7)', async () => {
		const t = await newT();
		const mailboxId = await seedMailbox(t, { address: 'me@example.com' });
		await seedFolder(t, mailboxId, 'inbox');
		const mailMessageId = await seedMessage(t, mailboxId);
		await t.run((ctx) => ctx.db.patch(mailboxId, { status: 'deleted' }));
		expect(
			await t.mutation(internal.decision.artifacts.claim, claimArgs({ mailMessageId, mailboxId }))
		).toEqual({ outcome: 'gone' });
		await t.run(async (ctx) => {
			await ctx.db.patch(mailboxId, { status: 'active' });
			await ctx.db.delete(mailMessageId);
		});
		expect(
			await t.mutation(internal.decision.artifacts.claim, claimArgs({ mailMessageId, mailboxId }))
		).toEqual({ outcome: 'gone' });
		expect(await rows(t)).toEqual([]);
	});

	it('keeps nothing when the message is deleted while the call runs (F7)', async () => {
		const t = await newT();
		const inboundMessageId = await teamMessage(t);
		const args = claimArgs({ inboundMessageId });
		const claim = await t.mutation(internal.decision.artifacts.claim, args);
		if (claim.outcome !== 'claimed') throw new Error(claim.outcome);
		await t.run((ctx) => ctx.db.delete(inboundMessageId));
		const done = await t.mutation(
			internal.decision.artifacts.complete,
			completeArgs(args.artifactKey, claim.leaseExpiresAt)
		);
		expect(done).toEqual({ isApplied: false });
		expect(await rows(t)).toEqual([]);
		expect(await memory(t)).toEqual([]);
	});

	it('never judges a message the owner corrected before the job claimed it (F4)', async () => {
		const t = await newT();
		const inboundMessageId = await teamMessage(t, { decisionCorrectedAt: Date.now() });
		expect(
			await t.mutation(internal.decision.artifacts.claim, claimArgs({ inboundMessageId }))
		).toEqual({ outcome: 'settled' });
		expect(await rows(t)).toEqual([]);
	});

	it('neither keeps nor learns an answer the owner corrected while it was in flight (F4)', async () => {
		const t = await newT();
		const inboundMessageId = await teamMessage(t);
		const args = claimArgs({ inboundMessageId });
		const claim = await t.mutation(internal.decision.artifacts.claim, args);
		if (claim.outcome !== 'claimed') throw new Error(claim.outcome);
		// The correction lands with no artifact to invalidate yet but the lease.
		await t.run((ctx) => ctx.db.patch(inboundMessageId, { decisionCorrectedAt: Date.now() }));
		await t.mutation(
			internal.decision.artifacts.complete,
			completeArgs(args.artifactKey, claim.leaseExpiresAt)
		);
		const [row] = await rows(t);
		expect(row).toMatchObject({ status: 'complete', invalidationReason: 'owner_correction' });
		expect(await memory(t)).toEqual([]);
	});

	it('refuses a hosted endpoint for an excluded mailbox and admits the local engine (F1)', async () => {
		const t = await newT();
		const mailboxId = await seedMailbox(t, { address: 'me@example.com' });
		await seedFolder(t, mailboxId, 'inbox');
		const mailMessageId = await seedMessage(t, mailboxId);
		await enableFeatures(t, ['ai.decisionPlane']);
		await t.run((ctx) => ctx.db.patch(mailboxId, { isExcludedFromHostedDecisions: true }));
		expect(
			await t.mutation(
				internal.decision.artifacts.claim,
				claimArgs(
					{ mailMessageId, mailboxId },
					{ rung: 'language', isLocal: false, isDecisionPlaneOn: true }
				)
			)
		).toEqual({ outcome: 'excluded' });
		expect(
			await t.mutation(
				internal.decision.artifacts.claim,
				claimArgs(
					{ mailMessageId, mailboxId },
					{ rung: 'decision', isLocal: true, isDecisionPlaneOn: true }
				)
			)
		).toMatchObject({ outcome: 'claimed' });
	});
});

describe('the gates and the endpoint snapshot, right before the call', () => {
	async function disable(t: T, flag: 'ai' | 'ai.agent' | 'ai.decisionPlane') {
		await t.run(async (ctx) => {
			const settings = await ctx.db.query('instanceSettings').first();
			await ctx.db.patch(settings!._id, {
				featureFlags: { ...settings!.featureFlags, [flag]: false },
			});
		});
	}

	it('refuses once the Team agent or the master ai flag is off (after scheduling)', async () => {
		for (const flag of ['ai.agent', 'ai'] as const) {
			const t = await newT();
			const inboundMessageId = await teamMessage(t);
			await disable(t, flag);
			expect(
				await t.mutation(internal.decision.artifacts.claim, claimArgs({ inboundMessageId }))
			).toEqual({ outcome: 'disabled' });
		}
	});

	it('refuses Postbox mail once the master ai flag is off', async () => {
		const t = await newT();
		const mailboxId = await seedMailbox(t, { address: 'me@example.com' });
		await seedFolder(t, mailboxId, 'inbox');
		const mailMessageId = await seedMessage(t, mailboxId);
		await disable(t, 'ai');
		expect(
			await t.mutation(internal.decision.artifacts.claim, claimArgs({ mailMessageId, mailboxId }))
		).toEqual({ outcome: 'disabled' });
	});

	it('refuses a decision-rung call once the plane is off or its configuration changed', async () => {
		const t = await newT();
		const inboundMessageId = await teamMessage(t);
		expect(
			await t.mutation(
				internal.decision.artifacts.claim,
				claimArgs({ inboundMessageId }, { rung: 'decision', isLocal: true })
			)
		).toEqual({ outcome: 'disabled' });
		await enableFeatures(t, ['ai.decisionPlane']);
		expect(
			await t.mutation(
				internal.decision.artifacts.claim,
				claimArgs(
					{ inboundMessageId },
					{ rung: 'decision', isLocal: true, isDecisionPlaneOn: true, configVersion: 'cfg:123' }
				)
			)
		).toEqual({ outcome: 'stale' });
		expect(
			await t.mutation(
				internal.decision.artifacts.claim,
				claimArgs(
					{ inboundMessageId },
					{ rung: 'decision', isLocal: true, isDecisionPlaneOn: true }
				)
			)
		).toMatchObject({ outcome: 'claimed' });
	});

	it('refuses a claim resolved from a save in the same millisecond as the current one (final F3)', async () => {
		const t = await newT();
		const inboundMessageId = await teamMessage(t);
		await enableFeatures(t, ['ai.decisionPlane']);
		const config = { ...typesafeWithoutKey(), decisionProviderKind: 'local' as const };
		const configId = await t.run((ctx) =>
			ctx.db.insert('aiProviderConfig', { ...config, configRevision: 1 })
		);
		// A second save at the same `updatedAt`: only the revision moved.
		await t.run((ctx) =>
			ctx.db.patch(configId, { decisionBaseUrl: 'http://other', configRevision: 2 })
		);
		const endpoint = { rung: 'decision' as const, isLocal: true, isDecisionPlaneOn: true };
		expect(
			await t.mutation(
				internal.decision.artifacts.claim,
				claimArgs({ inboundMessageId }, { ...endpoint, configVersion: `${configId}:1` })
			)
		).toEqual({ outcome: 'stale' });
		expect(
			await t.mutation(
				internal.decision.artifacts.claim,
				claimArgs({ inboundMessageId }, { ...endpoint, configVersion: `${configId}:2` })
			)
		).toMatchObject({ outcome: 'claimed' });
		// Removed and saved again: the revision restarts, the row id does not repeat.
		await t.run(async (ctx) => {
			await ctx.db.delete(configId);
			await ctx.db.insert('aiProviderConfig', { ...config, configRevision: 2 });
		});
		expect(
			await t.mutation(
				internal.decision.artifacts.claim,
				claimArgs({ inboundMessageId }, { ...endpoint, configVersion: `${configId}:2` })
			)
		).toEqual({ outcome: 'stale' });
	});

	it('refuses a language-rung call once a decision provider was configured since (Sol r4)', async () => {
		const t = await newT();
		const inboundMessageId = await teamMessage(t);
		await enableFeatures(t, ['ai.decisionPlane']);
		// Resolved to the language rung (`llm`, no stored config); then TypeSafe is
		// configured, with no key: D3 makes that terminal, so no language call.
		await t.run((ctx) => ctx.db.insert('aiProviderConfig', typesafeWithoutKey()));
		expect(
			await t.mutation(
				internal.decision.artifacts.claim,
				claimArgs(
					{ inboundMessageId },
					{ rung: 'language', isLocal: false, isDecisionPlaneOn: true }
				)
			)
		).toEqual({ outcome: 'stale' });
		expect(await rows(t)).toEqual([]);
	});

	it('refuses a language-rung call once the decision plane flag moved since (Sol r4)', async () => {
		const t = await newT();
		const inboundMessageId = await teamMessage(t);
		await enableFeatures(t, ['ai.decisionPlane']);
		await disable(t, 'ai.decisionPlane');
		expect(
			await t.mutation(
				internal.decision.artifacts.claim,
				claimArgs(
					{ inboundMessageId },
					{ rung: 'language', isLocal: false, isDecisionPlaneOn: true }
				)
			)
		).toEqual({ outcome: 'stale' });
		// And the other way round: decided with the plane off, then it is turned on.
		await enableFeatures(t, ['ai.decisionPlane']);
		expect(
			await t.mutation(
				internal.decision.artifacts.claim,
				claimArgs(
					{ inboundMessageId },
					{ rung: 'language', isLocal: false, isDecisionPlaneOn: false }
				)
			)
		).toEqual({ outcome: 'stale' });
	});
});

describe('the routing policy, right before the call (Sol r3)', () => {
	it('refuses a worker that planned under an older policy, or a plan the policy no longer makes', async () => {
		const t = await newT();
		const inboundMessageId = await teamMessage(t);
		// The switch turned off (and the version bumped) after the worker planned.
		await t.run(async (ctx) => {
			const row = await ctx.db.query('aiRoutingPolicy').first();
			await ctx.db.patch(row!._id, { categoryDisplayBundle: 'off', policyVersion: 2 });
		});
		expect(
			await t.mutation(internal.decision.artifacts.claim, claimArgs({ inboundMessageId }))
		).toEqual({ outcome: 'policy_changed' });
		// Same version, but the claim asks for a plan this policy does not make.
		expect(
			await t.mutation(internal.decision.artifacts.claim, {
				...claimArgs({ inboundMessageId }),
				policyVersion: 2,
			})
		).toEqual({ outcome: 'policy_changed' });
		expect(await rows(t)).toEqual([]);
	});

	it('refuses a mode the current policy does not plan (shadow worker, enforced switch)', async () => {
		const t = await newT();
		const inboundMessageId = await teamMessage(t);
		await t.run(async (ctx) => {
			const row = await ctx.db.query('aiRoutingPolicy').first();
			await ctx.db.patch(row!._id, { categoryDisplayBundle: 'enforce' });
		});
		expect(
			await t.mutation(internal.decision.artifacts.claim, claimArgs({ inboundMessageId }))
		).toEqual({ outcome: 'policy_changed' });
	});
});

describe('DMARC failures at ingestion (F5)', () => {
	beforeEach(() => expectScheduledFailure('agent/walker:start'));

	function remembered(
		scope: { scope: 'team_inbox' } | { scope: 'mailbox'; mailboxId: Id<'mailboxes'> }
	) {
		return {
			...scope,
			senderDigest: senderDigest('ada@example.com'),
			authBasis: 'dmarc_pass' as const,
			task: 'mail.category' as const,
			matchKind: 'exact' as const,
			matchKey: 'fingerprint',
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

	it('a Team message that fails DMARC invalidates the sender’s memory, with every switch off', async () => {
		const t = await newT();
		rateLimiterTest.register(t);
		await t.run((ctx) => ctx.db.insert('senderMemory', remembered({ scope: 'team_inbox' })));
		const base = {
			from: 'Ada <ada@example.com>',
			to: 'support@org.example',
			subject: 'Hello',
			textBody: 'Body',
			timestamp: Date.now(),
		};
		await t.mutation(internal.inbox.messages.receiveMessage, {
			...base,
			messageId: '<unknown@example.com>',
		});
		expect((await memory(t))[0]?.invalidatedAt).toBeUndefined();
		await t.mutation(internal.inbox.messages.receiveMessage, {
			...base,
			messageId: '<spoof@example.com>',
			dmarcResult: 'fail',
		});
		expect((await memory(t))[0]).toMatchObject({ invalidationReason: 'auth_failure' });
	});

	it('Postbox mail that fails DMARC invalidates the sender’s memory in that mailbox', async () => {
		const t = await newT();
		const mailboxId = await seedMailbox(t, { address: 'me@example.com' });
		const folderId = await seedFolder(t, mailboxId, 'inbox');
		await t.run(async (ctx) => {
			await ctx.db.insert('senderMemory', remembered({ scope: 'mailbox', mailboxId }));
			const mailbox = (await ctx.db.get(mailboxId))!;
			const folder = (await ctx.db.get(folderId))!;
			await insertDeliveredMessage(ctx, {
				mailbox,
				folder,
				rawStorageId: await ctx.storage.store(new Blob(['raw'])),
				rawSize: 3,
				from: 'ada@example.com',
				to: ['me@example.com'],
				cc: [],
				bcc: [],
				subject: 'Invoice',
				textBodyInline: 'Pay now',
				messageId: '<spoof@example.com>',
				receivedAt: Date.now(),
				attachments: [],
				dmarcResult: 'fail',
			});
		});
		expect((await memory(t))[0]).toMatchObject({ invalidationReason: 'auth_failure' });
	});
});
