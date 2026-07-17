import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../../../_generated/dataModel';
import type { ActionCtx } from '../../../../_generated/server';
import { runFinalAutoSendGates } from '../index';

/**
 * PP-26 — proof that the Slack approval hold is RESTRICT-ONLY within the final
 * auto-send gate chain: it runs last, so it can only hold a send that already
 * passed every core gate, and it can never override a core hold or bypass a core
 * gate. Slack's only reachable effect is the `ensureHold` mutation.
 */

const inboundMessageId = 'msg_chain' as Id<'inboundMessages'>;

const cleanMessage = {
	_id: inboundMessageId,
	from: 'Alice Customer <alice@customer.example>',
	to: 'support@example.test',
	subject: 'Order question',
	draftResponse: 'Thanks for reaching out — happy to help with your order.',
	securityFlags: { guardUnavailable: false },
	classification: {
		category: 'support',
		priority: 'normal',
		intent: 'question',
		sentiment: 'neutral',
		confidence: 0.95,
	},
} as unknown as Doc<'inboundMessages'>;

afterEach(() => {
	vi.unstubAllEnvs();
});

function activateSlack() {
	vi.stubEnv('SLACK_APPROVALS_SIGNING_SECRET', 'secret');
	vi.stubEnv('SLACK_APPROVALS_WEBHOOK_URL', 'https://hooks.slack.com/services/x');
}

interface ChainFixture {
	readonly budgetBlocked?: boolean;
	readonly ensureHold?: (() => Promise<{ release: boolean }>) | 'unused';
}

function context(fixture: ChainFixture = {}) {
	const mutations: string[] = [];
	const action = {
		runQuery: async (reference: unknown) => {
			const name = getFunctionName(reference as Parameters<typeof getFunctionName>[0]);
			if (name.includes('getCircuitBreakersInternal')) return [];
			if (name.includes('getMessage')) return cleanMessage;
			if (name.includes('getBudgetStatus')) {
				return fixture.budgetBlocked
					? { autonomousAutoSendAllowed: false, reason: 'AI spend budget exhausted.' }
					: { autonomousAutoSendAllowed: true };
			}
			if (name.includes('getAgentConfig')) return null;
			if (name.includes('evaluateForMessage')) return { restrictsAutoSend: false, reasons: [] };
			throw new Error(`Unexpected query: ${name}`);
		},
		runMutation: async (reference: unknown) => {
			const name = getFunctionName(reference as Parameters<typeof getFunctionName>[0]);
			mutations.push(name);
			if (name.includes('ensureHold')) {
				if (!fixture.ensureHold || fixture.ensureHold === 'unused') {
					throw new Error('ensureHold should not be reached');
				}
				return fixture.ensureHold();
			}
			throw new Error(`Unexpected mutation: ${name}`);
		},
	} as unknown as ActionCtx;
	return { action, mutations };
}

describe('runFinalAutoSendGates — Slack cannot override a core hold', () => {
	it('a core hold short-circuits before the Slack gate even when Slack would approve', async () => {
		activateSlack();
		// Slack would "release", but a core gate (spend budget) holds: the chain
		// must hold on the core reason and never reach ensureHold.
		const { action, mutations } = context({
			budgetBlocked: true,
			ensureHold: async () => ({ release: true }),
		});
		const decision = await runFinalAutoSendGates(action, inboundMessageId);
		expect(decision.safe).toBe(false);
		if (decision.safe) throw new Error('unreachable');
		expect(decision.reason).toMatch(/budget/i);
		// The Slack gate is never consulted once a core gate holds.
		expect(mutations.some((name) => name.includes('ensureHold'))).toBe(false);
	});
});

describe('runFinalAutoSendGates — Slack gate holds an otherwise-sendable message', () => {
	it('holds when core gates pass but Slack has no approval', async () => {
		activateSlack();
		const { action } = context({ ensureHold: async () => ({ release: false }) });
		const decision = await runFinalAutoSendGates(action, inboundMessageId);
		expect(decision.safe).toBe(false);
		if (!decision.safe) expect(decision.reason).toMatch(/slack approval/i);
	});

	it('releases only when core gates pass AND Slack quorum approved', async () => {
		activateSlack();
		const { action } = context({ ensureHold: async () => ({ release: true }) });
		expect(await runFinalAutoSendGates(action, inboundMessageId)).toEqual({ safe: true });
	});

	it('fails closed to a hold when the Slack gate errors', async () => {
		activateSlack();
		const { action } = context({
			ensureHold: async () => {
				throw new Error('convex down');
			},
		});
		const decision = await runFinalAutoSendGates(action, inboundMessageId);
		expect(decision.safe).toBe(false);
	});
});

describe('runFinalAutoSendGates — feature-off parity', () => {
	it('behaves as before (safe) when the Slack app is not configured', async () => {
		vi.stubEnv('SLACK_APPROVALS_SIGNING_SECRET', '');
		vi.stubEnv('SLACK_APPROVALS_WEBHOOK_URL', '');
		const { action, mutations } = context({ ensureHold: 'unused' });
		expect(await runFinalAutoSendGates(action, inboundMessageId)).toEqual({ safe: true });
		expect(mutations).toEqual([]);
	});
});
