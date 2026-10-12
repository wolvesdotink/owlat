/**
 * The applied-decision gate (clarify lane, Sol r3 F3), against real
 * artifacts: a Phase 3 verdict that was applied (an enforced claim check or
 * necessity judgment, stored as an `advisory` artifact) holds auto-send unless
 * the auto-send contract admits it. In this release nothing feeds auto-send,
 * so every applied verdict holds; a gate built for a feeding task still holds
 * an uncalibrated or stale one and lets a current, calibrated one through.
 * Shadow observations are inert.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import type { Doc, Id } from '../../_generated/dataModel';
import type { ActionCtx } from '../../_generated/server';
import type { AiTaskName } from '@owlat/shared/aiRouting';
import { createTestInboundMessage, enableFeatures } from '../../__tests__/factories';
import { modules } from '../../mail/__tests__/helpers.testlib';
import { CORE_FINAL_AUTO_SEND_GATE_IDS } from '../../agent/steps/route/autoSendGates';
import { appliedDecisionGate } from '../../agent/steps/route/appliedDecisionGate';
import { PINNED_DECISION_MODEL } from '../../lib/decisionProviders/typesafe';
import { __resetDecisionPlaneCacheForTests } from '../../lib/decisionProvider';

type T = ReturnType<typeof convexTest>;

const NOW = Date.now();
const REGISTRY = {
	'mail.claim_check': { en: 'baseline-2026-11' },
	'mail.necessity': { en: 'baseline-2026-11' },
};
const IDENTITY = `typesafe|${PINNED_DECISION_MODEL}|`;

async function setup() {
	const t = convexTest(schema, modules);
	vi.stubEnv('DECISION_PROVIDER', 'typesafe');
	vi.stubEnv('TYPESAFE_API_KEY', 'ts-live-0123456789abcdef');
	await enableFeatures(t, ['ai.decisionPlane']);
	await t.run((ctx) =>
		ctx.db.insert('agentConfig', {
			isAutoReplyEnabled: false,
			confidenceThreshold: 0.8,
			isItemCoverageEnforced: true,
			createdAt: NOW,
			updatedAt: NOW,
		})
	);
	const inboundMessageId = await t.run((ctx) =>
		ctx.db.insert(
			'inboundMessages',
			createTestInboundMessage({
				threadId: undefined,
				contactId: undefined,
				classification: {
					category: 'support',
					priority: 'normal',
					sentiment: 'neutral',
					intent: 'question',
					confidence: 0.9,
					language: 'en',
				},
			})
		)
	);
	return { t, inboundMessageId };
}

function artifact(
	inboundMessageId: Id<'inboundMessages'>,
	task: AiTaskName,
	over: Record<string, unknown> = {}
) {
	return {
		artifactKey: `k-${Math.random()}`,
		task,
		kind: 'advisory' as const,
		status: 'complete' as const,
		subjectKind: 'inbound_message' as const,
		inboundMessageId,
		contentHash: 'hash',
		policyVersion: 0,
		contextVersion: IDENTITY,
		provenance: { provider: 'typesafe' as const, questionSetId: task, questionSetVersion: 1 },
		calibration: {
			isAdapterCalibrated: true,
			calibrationRevision: 'baseline-2026-11',
			language: 'en',
		},
		expiresAt: NOW + 60_000,
		createdAt: NOW,
		updatedAt: NOW,
		...over,
	};
}

async function evaluate(
	t: T,
	inboundMessageId: Id<'inboundMessages'>,
	verdictTasks?: readonly AiTaskName[]
) {
	const query = t.query as (reference: unknown, args: unknown) => Promise<unknown>;
	const runAction = t.action as (reference: unknown, args: unknown) => Promise<unknown>;
	const gate = verdictTasks
		? appliedDecisionGate(undefined, verdictTasks, REGISTRY)
		: appliedDecisionGate();
	return gate.evaluate({
		action: { runQuery: query, runAction } as unknown as ActionCtx,
		inboundMessageId,
		now: () => NOW,
		getMessage: () =>
			t.run((ctx) => ctx.db.get(inboundMessageId)) as Promise<Doc<'inboundMessages'> | null>,
	});
}

afterEach(() => {
	vi.unstubAllEnvs();
	__resetDecisionPlaneCacheForTests();
});

describe('the registered applied-decision gate', () => {
	it('sits before the decision verdict gate', () => {
		expect(CORE_FINAL_AUTO_SEND_GATE_IDS.slice(-2)).toEqual([
			'applied_decision',
			'decision_verdict',
		]);
	});

	it('passes a message no Phase 3 verdict decided (off)', async () => {
		const { t, inboundMessageId } = await setup();
		expect(await evaluate(t, inboundMessageId)).toEqual({ safe: true });
	});

	it('ignores shadow observations (shadow is inert)', async () => {
		const { t, inboundMessageId } = await setup();
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'decisionArtifacts',
				artifact(inboundMessageId, 'mail.claim_check', { kind: 'shadow' })
			);
			await ctx.db.insert(
				'decisionArtifacts',
				artifact(inboundMessageId, 'mail.necessity', { kind: 'shadow' })
			);
		});
		expect(await evaluate(t, inboundMessageId)).toEqual({ safe: true });
	});

	it('stays inert past the read bound when every row is a shadow observation (Sol r4 F2)', async () => {
		const { t, inboundMessageId } = await setup();
		await t.run(async (ctx) => {
			for (let i = 0; i < 300; i++) {
				await ctx.db.insert(
					'decisionArtifacts',
					artifact(inboundMessageId, 'mail.claim_check', { kind: 'shadow' })
				);
			}
		});
		expect(await evaluate(t, inboundMessageId)).toEqual({ safe: true });
	});

	it('still holds when the APPLIED verdicts overflow the read bound', async () => {
		const { t, inboundMessageId } = await setup();
		await t.run(async (ctx) => {
			for (let i = 0; i < 257; i++) {
				await ctx.db.insert('decisionArtifacts', artifact(inboundMessageId, 'mail.claim_check'));
			}
		});
		expect(await evaluate(t, inboundMessageId)).toMatchObject({
			safe: false,
			reason: expect.stringContaining('Too many decision verdicts'),
		});
	});

	it.each(['mail.claim_check', 'mail.necessity'] as const)(
		'holds auto-send for an applied %s verdict, even a calibrated one: nothing feeds auto-send',
		async (task) => {
			const { t, inboundMessageId } = await setup();
			await t.run((ctx) => ctx.db.insert('decisionArtifacts', artifact(inboundMessageId, task)));
			expect(await evaluate(t, inboundMessageId)).toEqual({
				safe: false,
				reason: expect.stringContaining('its task does not feed auto-send'),
			});
		}
	);
});

describe('a gate for tasks that feed auto-send (the contract still decides)', () => {
	const FEEDING = ['mail.claim_check', 'mail.necessity'] as const;

	it.each([
		[
			'an uncalibrated claim check',
			'mail.claim_check',
			{ calibration: { isAdapterCalibrated: false } },
			/uncalibrated/,
		],
		[
			'a claim check from another model',
			'mail.claim_check',
			{ contextVersion: 'typesafe|jev-0.9|' },
			/different decision provider/,
		],
		[
			'a claim check under an older policy',
			'mail.claim_check',
			{ policyVersion: 9 },
			/routing policy/,
		],
		['an expired claim check', 'mail.claim_check', { expiresAt: NOW - 1 }, /expired/],
		[
			'an uncalibrated necessity judgment',
			'mail.necessity',
			{ calibration: { isAdapterCalibrated: false } },
			/uncalibrated/,
		],
		['a stale necessity judgment', 'mail.necessity', { invalidatedAt: NOW - 1 }, /invalidated/],
		[
			'a necessity judgment from the language rung',
			'mail.necessity',
			{
				contextVersion: 'language',
				provenance: { provider: 'language', questionSetId: 'q', questionSetVersion: 1 },
			},
			/different decision provider/,
		],
	] as const)('holds auto-send for %s', async (_label, task, over, reason) => {
		const { t, inboundMessageId } = await setup();
		await t.run((ctx) =>
			ctx.db.insert('decisionArtifacts', artifact(inboundMessageId, task, over))
		);
		const decision = await evaluate(t, inboundMessageId, FEEDING);
		expect(decision).toMatchObject({ safe: false });
		expect((decision as { reason: string }).reason).toMatch(reason);
	});

	it('lets a current, calibrated verdict through: the contract admits it', async () => {
		const { t, inboundMessageId } = await setup();
		await t.run(async (ctx) => {
			await ctx.db.insert('decisionArtifacts', artifact(inboundMessageId, 'mail.claim_check'));
			await ctx.db.insert('decisionArtifacts', artifact(inboundMessageId, 'mail.necessity'));
		});
		expect(await evaluate(t, inboundMessageId, FEEDING)).toEqual({ safe: true });
	});
});
