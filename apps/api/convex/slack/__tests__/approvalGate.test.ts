import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { runSlackApprovalHoldGate } from '../approvalGate';

const inboundMessageId = 'msg_1' as Id<'inboundMessages'>;

afterEach(() => {
	vi.unstubAllEnvs();
});

function activate() {
	vi.stubEnv('SLACK_APPROVALS_SIGNING_SECRET', 'secret');
	vi.stubEnv('SLACK_APPROVALS_WEBHOOK_URL', 'https://hooks.slack.com/services/x');
}

/** ActionCtx whose only reachable mutation is ensureHold. */
function context(ensureHold: (() => Promise<{ release: boolean }>) | 'unused') {
	const calls: string[] = [];
	const action = {
		runMutation: async (reference: unknown) => {
			const name = getFunctionName(reference as Parameters<typeof getFunctionName>[0]);
			calls.push(name);
			if (name.includes('ensureHold')) {
				if (ensureHold === 'unused') throw new Error('ensureHold should not be called');
				return ensureHold();
			}
			throw new Error(`Unexpected mutation: ${name}`);
		},
	} as unknown as ActionCtx;
	return { action, calls };
}

describe('runSlackApprovalHoldGate — inactive app is inert', () => {
	it('is safe and touches no mutation when unconfigured', async () => {
		vi.stubEnv('SLACK_APPROVALS_SIGNING_SECRET', '');
		vi.stubEnv('SLACK_APPROVALS_WEBHOOK_URL', '');
		const { action, calls } = context('unused');
		expect(await runSlackApprovalHoldGate(action, inboundMessageId)).toEqual({ safe: true });
		expect(calls).toEqual([]);
	});

	it('is inert when only one secret is set', async () => {
		vi.stubEnv('SLACK_APPROVALS_SIGNING_SECRET', 'secret');
		vi.stubEnv('SLACK_APPROVALS_WEBHOOK_URL', '');
		const { action, calls } = context('unused');
		expect(await runSlackApprovalHoldGate(action, inboundMessageId)).toEqual({ safe: true });
		expect(calls).toEqual([]);
	});
});

describe('runSlackApprovalHoldGate — active app holds until approved', () => {
	it('holds when the request is not yet released', async () => {
		activate();
		const { action } = context(async () => ({ release: false }));
		const decision = await runSlackApprovalHoldGate(action, inboundMessageId);
		expect(decision.safe).toBe(false);
	});

	it('releases only when the request reports release', async () => {
		activate();
		const { action } = context(async () => ({ release: true }));
		expect(await runSlackApprovalHoldGate(action, inboundMessageId)).toEqual({ safe: true });
	});
});

describe('runSlackApprovalHoldGate — fails closed', () => {
	it('holds when ensureHold throws (Slack/DB error)', async () => {
		activate();
		const { action } = context(async () => {
			throw new Error('convex unavailable');
		});
		const decision = await runSlackApprovalHoldGate(action, inboundMessageId);
		expect(decision.safe).toBe(false);
	});
});
