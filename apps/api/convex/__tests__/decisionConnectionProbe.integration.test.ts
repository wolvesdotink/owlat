/**
 * `testConnection({ plane: 'decision' })` — the settings button, end to end.
 *
 * The property under test is that the button MEANS something. A well-formed,
 * revoked key passes every local check and then fails every decision afterwards
 * on the inbound path, where nobody is watching a button, so this branch asks
 * the provider one registered probe question and reports what came back.
 *
 * Four things are pinned here: the kill switch is consulted BEFORE anything
 * leaves the deployment, a working key produces a real round trip that lands in
 * the usage ledger, a rejected key comes back in the adapter's own words (and
 * never with the key in them), and a provider that answers with a model we did
 * not pin is not reported as a plain success.
 *
 * The socket is stubbed at `lib/ssrfGuard.fetchGuarded`, the seam the adapter
 * actually uses, so nothing resolves DNS and the guard's own behaviour stays
 * covered by its own suite. Key crypto is REAL: the probe must run on the key
 * that was encrypted, decrypted and resolved, not on a fixture.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { api } from '../_generated/api';
import { typesafeDecisionAdapter, PINNED_DECISION_MODEL } from '../lib/decisionProviders/typesafe';
import { __resetDecisionPlaneCacheForTests } from '../lib/decisionProvider';

vi.stubEnv('INSTANCE_SECRET', 'test-instance-secret-value-for-aes-256-gcm-kdf');

/** A stand-in for an operator's key — searched for below, never a real one. */
const DECISION_KEY = 'typesafe-probe-key-000000';

const sessionMocks = vi.hoisted(() => ({
	session: { userId: 'test-admin', role: 'owner' as const },
}));

const guard = vi.hoisted(() => ({ fetchGuarded: vi.fn() }));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(async () => sessionMocks.session),
		requireOrgPermission: vi.fn().mockImplementation(async () => sessionMocks.session),
	};
});

vi.mock('../lib/ssrfGuard', async () => ({
	...(await vi.importActual('../lib/ssrfGuard')),
	fetchGuarded: guard.fetchGuarded,
}));

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
			!path.includes('visualizationAgent')
	)
);

const identity = {
	subject: 'test-admin',
	issuer: 'https://test.issuer.com',
	tokenIdentifier: 'https://test.issuer.com|test-admin',
};

/** The one answer the probe question set expects back, in the vendor's shape. */
function probeBody(model: string = PINNED_DECISION_MODEL): string {
	return JSON.stringify({
		model,
		answers: { reachable: { type: 'noul', noul: 0.98 } },
		usage: { input_tokens: 21, output_tokens: 1 },
	});
}

function jsonResponse(body: string, status = 200): Response {
	return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

async function setup(featureFlags?: Record<string, boolean>) {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	if (featureFlags) {
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
	}
	const authed = t.withIdentity(identity);
	await authed.action(api.aiProviderConfigActions.saveConfig, {
		languageProviderKind: 'anthropic',
		apiKey: 'sk-ant-language-key-1234',
		decisionProviderKind: 'typesafe',
		decisionApiKey: DECISION_KEY,
	});
	return authed;
}

beforeEach(() => {
	guard.fetchGuarded.mockReset();
	// The resolver caches the decrypted plane per config version, and each test
	// builds a new deployment with the same `updatedAt` resolution — drop it so
	// one test's plane is never answered from another's.
	__resetDecisionPlaneCacheForTests();
});

describe("testConnection({ plane: 'decision' })", () => {
	it('preserves billed usage when an answer is refused by the codec', async () => {
		const t = await setup({ ai: true, 'ai.decisionPlane': true });
		const body = JSON.parse(probeBody());
		body.answers.reachable.noul = 2;
		guard.fetchGuarded.mockResolvedValue(jsonResponse(JSON.stringify(body)));
		const res = await t.action(api.aiProviderConfigActions.testConnection, { plane: 'decision' });
		expect(res.ok).toBe(false);
		const rows = await t.run(async (ctx) => await ctx.db.query('llmUsageEvents').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]?.promptTokens).toBe(21);
		expect(rows[0]?.costUsd).toBeGreaterThan(0);
		expect(rows[0]?.isCalibrated).toBeUndefined();
		expect(guard.fetchGuarded).toHaveBeenCalledTimes(1);
	});

	it('sends nothing at all while the kill switch is off', async () => {
		const t = await setup({ ai: true, 'ai.decisionPlane': false });

		const res = await t.action(api.aiProviderConfigActions.testConnection, {
			plane: 'decision',
		});

		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/disabled/i);
		// The whole point of a kill switch: nothing leaves the deployment while it
		// is off, including a test somebody presses during the incident.
		expect(guard.fetchGuarded).not.toHaveBeenCalled();
	});

	it('asks the provider one real question and records what it spent', async () => {
		const t = await setup({ ai: true, 'ai.decisionPlane': true });
		guard.fetchGuarded.mockResolvedValue(jsonResponse(probeBody()));

		const res = await t.action(api.aiProviderConfigActions.testConnection, {
			plane: 'decision',
		});

		expect(res).toEqual({ ok: true });
		const [url, init] = guard.fetchGuarded.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://api.typesafe.ai/v1/systemone');
		// The DECRYPTED stored key, through the crypto round-trip.
		expect((init.headers as Record<string, string>)['authorization']).toBe(
			`Bearer ${DECISION_KEY}`
		);

		// The spend the button authorised is in the ledger the ceiling reads,
		// tagged as the decision plane's.
		const rows = await t.run(async (ctx) => await ctx.db.query('llmUsageEvents').collect());
		const probe = rows.filter((row) => row.plane === 'decision');
		expect(probe).toHaveLength(1);
		expect(probe[0]).toMatchObject({ promptTokens: 21, isFallback: false, isCalibrated: true });
		expect(JSON.stringify(rows)).not.toContain(DECISION_KEY);
	});

	it("reports a rejected key in the adapter's words, without the key in them", async () => {
		const t = await setup({ ai: true, 'ai.decisionPlane': true });
		guard.fetchGuarded.mockResolvedValue(
			new Response(`{"error":"invalid key ${DECISION_KEY}"}`, { status: 401 })
		);

		const res = await t.action(api.aiProviderConfigActions.testConnection, {
			plane: 'decision',
		});

		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/rejected the API key/i);
		expect(res.error).not.toContain(DECISION_KEY);
		// 401 is neither retried nor followed by a hop, so one request is all.
		expect(guard.fetchGuarded).toHaveBeenCalledTimes(1);
	});

	it('does not call an answer from an unpinned model version a success', async () => {
		const t = await setup({ ai: true, 'ai.decisionPlane': true });
		guard.fetchGuarded.mockResolvedValue(jsonResponse(probeBody('jev-1.14.0')));

		const res = await t.action(api.aiProviderConfigActions.testConnection, {
			plane: 'decision',
		});

		// The key works. What does not is the assumption every threshold rests on.
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/jev-1\.14\.0/);
		expect(res.error).toMatch(/uncalibrated/i);
	});
});

describe('decision model discovery', () => {
	it.each([false, true])(
		'gates a future network discovery implementation (enabled=%s)',
		async (enabled) => {
			const t = await setup({ ai: true, 'ai.decisionPlane': enabled });
			guard.fetchGuarded.mockResolvedValue(jsonResponse('{}'));
			const discovery = vi
				.spyOn(typesafeDecisionAdapter, 'listModels')
				.mockImplementation(async (cfg) => {
					await cfg.fetchImpl!('https://api.typesafe.ai/v1/models');
					return ['test-model'];
				});
			try {
				const result = await t.action(api.aiProviderConfigActions.listModels, {
					plane: 'decision',
				});
				expect(guard.fetchGuarded).toHaveBeenCalledTimes(enabled ? 1 : 0);
				if (enabled) expect(result.models).toEqual(['test-model']);
				else expect(result.error).toMatch(/disabled/i);
			} finally {
				discovery.mockRestore();
			}
		}
	);
});
