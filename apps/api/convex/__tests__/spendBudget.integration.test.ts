/**
 * Per-org spend budget, end-to-end over the `llmUsageEvents` ledger:
 *   - under budget → autonomous auto-send + advisory both allowed;
 *   - over budget → autonomous path degrades to draft-only (auto-send withheld)
 *     and advisory (aiGate) is blocked with a clear reason;
 *   - the budget resets per period (a previous-period event is not counted).
 */
import { convexTest } from 'convex-test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { internal } from '../_generated/api';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'owner',
			activeOrganizationId: 'test-org',
		}),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('visualizationAgent') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('llmProvider')
	)
);

const BUDGET_ENV = [
	'AI_SPEND_DAILY_BUDGET_USD',
	'AI_SPEND_MONTHLY_BUDGET_USD',
	'AI_SPEND_WARN_FRACTION',
	'AI_SPEND_ADVISORY_RESERVE_FRACTION',
] as const;

afterEach(() => {
	for (const k of BUDGET_ENV) delete process.env[k];
	vi.restoreAllMocks();
});

async function insertSpend(t: ReturnType<typeof convexTest>, costUsd: number, at: number) {
	await t.run(async (ctx) => {
		await ctx.db.insert('llmUsageEvents', {
			feature: 'agent_draft',
			modelUsed: 'gpt-4o',
			promptTokens: 1000,
			completionTokens: 1000,
			totalTokens: 2000,
			costUsd,
			createdAt: at,
		});
	});
}

async function setAiFlag(t: ReturnType<typeof convexTest>, on: boolean) {
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			featureFlags: { ai: on },
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

describe('analytics.spendBudget.getBudgetStatus', () => {
	it('is unconfigured + fully permissive when no ceiling env is set', async () => {
		const t = convexTest(schema, modules);
		await insertSpend(t, 1000, Date.now());
		const status = await t.query(internal.analytics.spendBudget.getBudgetStatus, {});
		expect(status.configured).toBe(false);
		expect(status.autonomousAutoSendAllowed).toBe(true);
		expect(status.advisoryAllowed).toBe(true);
	});

	it('allows both paths while under the daily ceiling', async () => {
		process.env.AI_SPEND_DAILY_BUDGET_USD = '10';
		const t = convexTest(schema, modules);
		await insertSpend(t, 1, Date.now());
		const status = await t.query(internal.analytics.spendBudget.getBudgetStatus, {});
		expect(status.autonomousAutoSendAllowed).toBe(true);
		expect(status.advisoryAllowed).toBe(true);
		expect(status.daily.remainingUsd).toBeCloseTo(9);
	});

	it('withholds autonomous auto-send once the daily ceiling is exceeded', async () => {
		process.env.AI_SPEND_DAILY_BUDGET_USD = '10';
		const t = convexTest(schema, modules);
		await insertSpend(t, 6, Date.now());
		await insertSpend(t, 6, Date.now());
		const status = await t.query(internal.analytics.spendBudget.getBudgetStatus, {});
		expect(status.autonomousAutoSendAllowed).toBe(false);
		expect(status.advisoryAllowed).toBe(false);
		expect(status.reason).toMatch(/spend budget/i);
	});

	it('resets per period — a previous-day event is not counted against today', async () => {
		process.env.AI_SPEND_DAILY_BUDGET_USD = '10';
		const t = convexTest(schema, modules);
		const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
		await insertSpend(t, 50, twoDaysAgo); // last period — must not count today
		const status = await t.query(internal.analytics.spendBudget.getBudgetStatus, {});
		expect(status.daily.spentUsd).toBe(0);
		expect(status.autonomousAutoSendAllowed).toBe(true);
	});
});

describe('mail.aiGate.assertAiAllowed with a spend budget', () => {
	it('blocks advisory AI with a clear reason once the budget is exhausted', async () => {
		process.env.AI_SPEND_DAILY_BUDGET_USD = '10';
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await setAiFlag(t, true);
		await insertSpend(t, 12, Date.now());

		await expect(t.mutation(internal.mail.aiGate.assertAiAllowed, {})).rejects.toThrow(
			/spend budget|paused/i
		);
	});

	it('allows advisory AI while under budget', async () => {
		process.env.AI_SPEND_DAILY_BUDGET_USD = '10';
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await setAiFlag(t, true);
		await insertSpend(t, 1, Date.now());

		await expect(t.mutation(internal.mail.aiGate.assertAiAllowed, {})).resolves.toBeNull();
	});
});
