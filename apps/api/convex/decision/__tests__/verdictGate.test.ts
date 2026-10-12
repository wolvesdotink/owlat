/**
 * The block-only decision verdict gate in `CORE_FINAL_AUTO_SEND_GATES`
 * (ADR-0060 §8, ADR-0073 §8), against real artifacts. Nothing feeds a verdict
 * to auto-send in this release, so the registered gate blocks nothing; a gate
 * built for a task that does feed one blocks every stale or uncalibrated
 * verdict and lets only a current, calibrated one through.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import type { Doc, Id } from '../../_generated/dataModel';
import type { ActionCtx } from '../../_generated/server';
import { createTestInboundMessage, enableFeatures } from '../../__tests__/factories';
import { modules } from '../../mail/__tests__/helpers.testlib';
import {
	CORE_FINAL_AUTO_SEND_GATE_IDS,
	decisionVerdictGate,
} from '../../agent/steps/route/autoSendGates';
import { AUTO_SEND_VERDICT_TASKS } from '../../lib/decision/calibration';

type T = ReturnType<typeof convexTest>;

const NOW = Date.now();
const REGISTRY = { 'mail.draft_quality': { en: 'baseline-2026-11' } };

async function setup() {
	const t = convexTest(schema, modules);
	vi.stubEnv('DECISION_PROVIDER', 'typesafe');
	await enableFeatures(t, ['ai.decisionPlane']);
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

function verdict(inboundMessageId: Id<'inboundMessages'>, over: Record<string, unknown> = {}) {
	return {
		artifactKey: `k-${Math.random()}`,
		task: 'mail.draft_quality' as const,
		kind: 'advisory' as const,
		status: 'complete' as const,
		subjectKind: 'inbound_message' as const,
		inboundMessageId,
		contentHash: 'hash',
		policyVersion: 0,
		contextVersion: 'typesafe||',
		provenance: { provider: 'typesafe' as const, questionSetId: 'q', questionSetVersion: 1 },
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
	tasks = ['mail.draft_quality'] as const
) {
	const query = t.query as (reference: unknown, args: unknown) => Promise<unknown>;
	const runQuery = vi.fn((reference: unknown, args: unknown) => query(reference, args));
	const decision = await decisionVerdictGate([...tasks], REGISTRY).evaluate({
		action: { runQuery } as unknown as ActionCtx,
		inboundMessageId,
		now: () => NOW,
		getMessage: () =>
			t.run((ctx) => ctx.db.get(inboundMessageId)) as Promise<Doc<'inboundMessages'> | null>,
	});
	return { decision, runQuery };
}

afterEach(() => vi.unstubAllEnvs());

describe('the registered decision verdict gate', () => {
	it('is the last core final gate and, with nothing feeding a verdict, reads nothing', async () => {
		expect(CORE_FINAL_AUTO_SEND_GATE_IDS[CORE_FINAL_AUTO_SEND_GATE_IDS.length - 1]).toBe(
			'decision_verdict'
		);
		expect(AUTO_SEND_VERDICT_TASKS).toEqual([]);
		const { t, inboundMessageId } = await setup();
		await t.run((ctx) =>
			ctx.db.insert(
				'decisionArtifacts',
				verdict(inboundMessageId, { calibration: { isAdapterCalibrated: false } })
			)
		);
		const runQuery = vi.fn();
		const decision = await decisionVerdictGate(AUTO_SEND_VERDICT_TASKS).evaluate({
			action: { runQuery } as unknown as ActionCtx,
			inboundMessageId,
			now: () => NOW,
			getMessage: async () => null,
		});
		expect(decision).toEqual({ safe: true });
		expect(runQuery).not.toHaveBeenCalled();
	});
});

describe('a verdict gate for a task that feeds auto-send', () => {
	it('lets the send through when the message has no verdict', async () => {
		const { t, inboundMessageId } = await setup();
		expect((await evaluate(t, inboundMessageId)).decision).toEqual({ safe: true });
	});

	it('lets a current, calibrated verdict through', async () => {
		const { t, inboundMessageId } = await setup();
		await t.run((ctx) => ctx.db.insert('decisionArtifacts', verdict(inboundMessageId)));
		expect((await evaluate(t, inboundMessageId)).decision).toEqual({ safe: true });
	});

	it.each<[string, Record<string, unknown>, RegExp]>([
		[
			'an uncalibrated adapter',
			{
				calibration: {
					isAdapterCalibrated: false,
					calibrationRevision: 'baseline-2026-11',
					language: 'en',
				},
			},
			/uncalibrated/,
		],
		[
			'no calibration revision',
			{ calibration: { isAdapterCalibrated: true, language: 'en' } },
			/valid calibration/,
		],
		['a stale policy', { policyVersion: 3 }, /routing policy/],
		['another provider', { contextVersion: 'local||' }, /different decision provider/],
		[
			'an invalidated verdict',
			{ invalidatedAt: NOW - 1, invalidationReason: 'owner_correction' },
			/invalidated/,
		],
		['a shadow observation', { kind: 'shadow' }, /shadow/],
		['a failed verdict', { status: 'failed' }, /not complete/],
	])('blocks %s', async (_name, over, reason) => {
		const { t, inboundMessageId } = await setup();
		await t.run(async (ctx) => {
			await ctx.db.insert('decisionArtifacts', verdict(inboundMessageId));
			await ctx.db.insert('decisionArtifacts', verdict(inboundMessageId, over));
		});
		const { decision } = await evaluate(t, inboundMessageId);
		expect(decision).toMatchObject({ safe: false, reason: expect.stringMatching(reason) });
	});

	it('holds rather than judge a partial set of verdicts', async () => {
		const { t, inboundMessageId } = await setup();
		await t.run(async (ctx) => {
			for (let i = 0; i < 33; i++)
				await ctx.db.insert('decisionArtifacts', verdict(inboundMessageId));
		});
		const { decision } = await evaluate(t, inboundMessageId);
		expect(decision).toMatchObject({ safe: false, reason: expect.stringMatching(/Too many/) });
	});

	it('blocks once the decision plane is switched off', async () => {
		const { t, inboundMessageId } = await setup();
		await t.run(async (ctx) => {
			await ctx.db.insert('decisionArtifacts', verdict(inboundMessageId));
			const settings = await ctx.db.query('instanceSettings').first();
			await ctx.db.patch(settings!._id, {
				featureFlags: { ...settings!.featureFlags, 'ai.decisionPlane': false },
			});
		});
		const { decision } = await evaluate(t, inboundMessageId);
		expect(decision).toMatchObject({
			safe: false,
			reason: expect.stringMatching(/different decision provider/),
		});
	});
});
