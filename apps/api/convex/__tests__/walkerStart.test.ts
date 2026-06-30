/**
 * Regression test for the Agent walker entry edge.
 *
 * The inbound AI pipeline starts at `walker.start`, which must advance the
 * message `received → security_check` BEFORE running the `security_scan` step
 * (whose route emits `classifying` / `quarantined` / `archived`, legal only
 * from `security_check`). A prior regression skipped this transition, so the
 * step's first emit was rejected as an illegal edge and the message stalled in
 * `received` with no draft ever produced — and no test caught it because the
 * lifecycle tests drove `received → security_check` manually and excluded the
 * walker. This test exercises the real entry point.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { enableFeatures } from './factories';

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

const modules = import.meta.glob('../**/*.*s');

async function createMessage(
	t: ReturnType<typeof convexTest>,
	processingStatus: string,
): Promise<Id<'inboundMessages'>> {
	return await t.run(async (ctx) =>
		ctx.db.insert('inboundMessages', {
			messageId: `msg-${Math.random().toString(36).slice(2)}`,
			from: 'sender@example.com',
			to: 'support@owlat.app',
			subject: 'Help please',
			textBody: 'I need help',
			processingStatus,
			receivedAt: Date.now(),
		} as never),
	);
}

describe('agent walker.start — pipeline entry edge', () => {
	it('advances a received message to security_check so the scan step can run', async () => {
		const t = convexTest(schema, modules);
		const id = await createMessage(t, 'received');

		await t.action(internal.agent.walker.start, { inboundMessageId: id });

		const msg = await t.run(async (ctx) => ctx.db.get(id));
		expect(msg?.processingStatus).toBe('security_check');
	});

	it('is a no-op when the message is not in received (e.g. already sent)', async () => {
		const t = convexTest(schema, modules);
		const id = await createMessage(t, 'sent');

		await t.action(internal.agent.walker.start, { inboundMessageId: id });

		const msg = await t.run(async (ctx) => ctx.db.get(id));
		expect(msg?.processingStatus).toBe('sent');
	});

	it('fails the step action and stops when a step transition is rejected', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		// Terminal state: any pipeline transition the scan step emits is illegal,
		// so runStep must close the action and stop rather than silently advance.
		const id = await createMessage(t, 'archived');

		await t.action(internal.agent.walker.runStep, {
			inboundMessageId: id,
			kind: 'security_scan',
			input: { inboundMessageId: id },
		});

		const msg = await t.run(async (ctx) => ctx.db.get(id));
		expect(msg?.processingStatus).toBe('archived'); // not advanced

		const action = await t.run(async (ctx) => {
			const rows = await ctx.db.query('agentActions').collect();
			return rows.find((a) => a.inboundMessageId === id);
		});
		expect(action?.status).toBe('failed'); // dangling action closed, not left running
	});
});
