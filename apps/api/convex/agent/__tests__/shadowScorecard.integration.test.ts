/**
 * Integration tests for the shadow ("would-have-sent") scorecard.
 *
 * Covers the three spec behaviours end-to-end against a real Convex test db:
 *   - shadow observations are recorded and reconciled against the human action;
 *   - the scorecard aggregates matches per (category, sender);
 *   - a graduation offer surfaces ONLY when a slice clears the thresholds.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import { createTestInboundMessage, enableFeatures } from '../../__tests__/factories';
import {
	GRADUATION_MIN_SAMPLE,
	MATCH_SIMILARITY_THRESHOLD,
} from '../shadowScorecard';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireAuthenticatedIdentity: vi
			.fn()
			.mockResolvedValue({ subject: 'test-user', issuer: 'test', tokenIdentifier: 'test|test-user' }),
	};
});

vi.mock('../../lib/posthogHelpers', async () => ({
	trackEvent: vi.fn().mockResolvedValue(undefined),
}));

const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/index') &&
			!path.includes('agent/steps/classify') &&
			!path.includes('agent/steps/draft') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider'),
	),
);

const DRAFT = 'Thanks for reaching out — happy to help with your order.';

async function seedShadowedMessage(
	t: ReturnType<typeof convexTest>,
	opts: { from: string; category: string; wouldHaveSent: boolean; draft?: string },
) {
	const inboundMessageId = await t.run(async (ctx) =>
		ctx.db.insert(
			'inboundMessages',
			createTestInboundMessage({ from: opts.from, draftResponse: opts.draft ?? DRAFT }),
		),
	);
	await t.mutation(internal.agent.shadowScorecard.recordShadowDecision, {
		inboundMessageId,
		category: opts.category,
		wouldHaveSent: opts.wouldHaveSent,
		reason: 'test',
		confidence: 0.95,
		draftQualityScore: 0.95,
	});
	return inboundMessageId;
}

describe('shadowScorecard — getShadowMode', () => {
	it('defaults to enabled when there is no agentConfig row', async () => {
		const t = convexTest(schema, modules);
		const res = await t.query(internal.agent.shadowScorecard.getShadowMode, {});
		expect(res.enabled).toBe(true);
	});

	it('is disabled only when shadowMode is explicitly false', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) =>
			ctx.db.insert('agentConfig', {
				isAutoReplyEnabled: false,
				confidenceThreshold: 0.85,
				shadowMode: false,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		const res = await t.query(internal.agent.shadowScorecard.getShadowMode, {});
		expect(res.enabled).toBe(false);
	});
});

describe('shadowScorecard — record + reconcile', () => {
	it('counts an approved unedited would-have-sent draft as a match', async () => {
		const t = convexTest(schema, modules);
		const id = await seedShadowedMessage(t, {
			from: 'Alice <alice@customer.example>',
			category: 'support',
			wouldHaveSent: true,
		});

		await t.mutation(internal.agent.shadowScorecard.reconcileShadowDecision, {
			inboundMessageId: id,
			action: 'approved',
		});

		const observation = await t.run(async (ctx) =>
			ctx.db
				.query('agentShadowDecisions')
				.withIndex('by_message', (q) => q.eq('inboundMessageId', id))
				.first(),
		);
		expect(observation?.resolved).toBe(true);
		expect(observation?.matched).toBe(true);
		expect(observation?.similarity).toBeGreaterThanOrEqual(MATCH_SIMILARITY_THRESHOLD);

		await enableFeatures(t, ['ai.autonomy']);
		const scorecard = await t.query(api.agent.shadowScorecard.getShadowScorecard, {});
		expect(scorecard).toHaveLength(1);
		expect(scorecard[0]!.category).toBe('support');
		expect(scorecard[0]!.sender).toBe('alice@customer.example');
		expect(scorecard[0]!.samples).toBe(1);
		expect(scorecard[0]!.wouldHaveSent).toBe(1);
		expect(scorecard[0]!.matched).toBe(1);
	});

	it('does not count an edited draft as a match even if would-have-sent', async () => {
		const t = convexTest(schema, modules);
		const id = await seedShadowedMessage(t, {
			from: 'Bob <bob@customer.example>',
			category: 'billing',
			wouldHaveSent: true,
		});

		// The human materially rewrote the draft before approving.
		await t.run(async (ctx) =>
			ctx.db.patch(id, {
				draftResponse: 'We cannot process this; please contact billing directly for a refund.',
			}),
		);
		await t.mutation(internal.agent.shadowScorecard.reconcileShadowDecision, {
			inboundMessageId: id,
			action: 'edited',
		});

		const observation = await t.run(async (ctx) =>
			ctx.db
				.query('agentShadowDecisions')
				.withIndex('by_message', (q) => q.eq('inboundMessageId', id))
				.first(),
		);
		expect(observation?.matched).toBe(false);

		await enableFeatures(t, ['ai.autonomy']);
		const scorecard = await t.query(api.agent.shadowScorecard.getShadowScorecard, {});
		expect(scorecard[0]!.wouldHaveSent).toBe(1);
		expect(scorecard[0]!.matched).toBe(0);
	});

	it('aggregates matches per (category, sender) across messages', async () => {
		const t = convexTest(schema, modules);
		// Same sender + category, two approved-unedited matches.
		for (let i = 0; i < 2; i++) {
			const id = await seedShadowedMessage(t, {
				from: 'Alice <alice@customer.example>',
				category: 'support',
				wouldHaveSent: true,
			});
			await t.mutation(internal.agent.shadowScorecard.reconcileShadowDecision, {
				inboundMessageId: id,
				action: 'approved',
			});
		}
		// A different sender in the same category.
		const other = await seedShadowedMessage(t, {
			from: 'Carol <carol@customer.example>',
			category: 'support',
			wouldHaveSent: true,
		});
		await t.mutation(internal.agent.shadowScorecard.reconcileShadowDecision, {
			inboundMessageId: other,
			action: 'rejected',
		});

		await enableFeatures(t, ['ai.autonomy']);
		const scorecard = await t.query(api.agent.shadowScorecard.getShadowScorecard, {});
		const alice = scorecard.find((s) => s.sender === 'alice@customer.example');
		const carol = scorecard.find((s) => s.sender === 'carol@customer.example');
		expect(alice!.wouldHaveSent).toBe(2);
		expect(alice!.matched).toBe(2);
		expect(carol!.wouldHaveSent).toBe(1);
		expect(carol!.matched).toBe(0);
	});
});

describe('shadowScorecard — graduation offer', () => {
	it('offers graduation only for a slice that clears the thresholds', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.autonomy']);

		await t.run(async (ctx) => {
			// Cleared: enough would-have-sent AND a high match rate.
			await ctx.db.insert('agentShadowScorecard', {
				category: 'support',
				sender: 'ready@customer.example',
				samples: GRADUATION_MIN_SAMPLE + 5,
				wouldHaveSent: GRADUATION_MIN_SAMPLE + 5,
				matched: GRADUATION_MIN_SAMPLE + 4,
				lastActivityAt: Date.now(),
			});
			// Too few observations.
			await ctx.db.insert('agentShadowScorecard', {
				category: 'support',
				sender: 'new@customer.example',
				samples: 3,
				wouldHaveSent: 3,
				matched: 3,
				lastActivityAt: Date.now(),
			});
			// Enough volume but a poor match rate.
			await ctx.db.insert('agentShadowScorecard', {
				category: 'billing',
				sender: 'noisy@customer.example',
				samples: GRADUATION_MIN_SAMPLE + 10,
				wouldHaveSent: GRADUATION_MIN_SAMPLE + 10,
				matched: 2,
				lastActivityAt: Date.now(),
			});
		});

		const scorecard = await t.query(api.agent.shadowScorecard.getShadowScorecard, {});
		const ready = scorecard.find((s) => s.sender === 'ready@customer.example');
		const fresh = scorecard.find((s) => s.sender === 'new@customer.example');
		const noisy = scorecard.find((s) => s.sender === 'noisy@customer.example');

		expect(ready!.offerGraduation).toBe(true);
		expect(fresh!.offerGraduation).toBe(false);
		expect(noisy!.offerGraduation).toBe(false);
	});
});
