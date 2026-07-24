import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import schema from '../schema';
import { createTestTransactionalEmail } from './factories';

const { campaignEnqueueAction, transactionalEnqueueAction } = vi.hoisted(() => ({
	campaignEnqueueAction: vi.fn().mockResolvedValue('campaign-work-1'),
	transactionalEnqueueAction: vi.fn().mockResolvedValue('transactional-work-1'),
}));
vi.mock('../delivery/workpool', () => ({
	campaignEmailPool: { enqueueAction: campaignEnqueueAction },
	transactionalEmailPool: { enqueueAction: transactionalEnqueueAction },
}));

const modules = import.meta.glob('../**/*.*s');

beforeEach(() => {
	campaignEnqueueAction.mockClear();
	transactionalEnqueueAction.mockClear();
	vi.stubEnv('INSTANCE_SECRET', 'routing-reentry-test-secret-at-least-32-characters');
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('transactional MTA routing re-entry', () => {
	it('uses the transactional Send reference and pool through the shared state machine', async () => {
		const t = convexTest(schema, modules);
		let sendId: Id<'transactionalSends'>;
		await t.run(async (ctx) => {
			const transactionalEmailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail()
			);
			sendId = await ctx.db.insert('transactionalSends', {
				kind: 'transactional',
				transactionalEmailId,
				email: 'transactional@example.com',
				status: 'queued',
				queuedAt: Date.now(),
			});
		});

		const envelopeInput = {
			kind: 'transactional' as const,
			emailPurpose: 'transactional' as const,
			to: 'transactional@example.com',
			from: 'sender@example.org',
			sendId: sendId!,
			template: { subject: 'Hello', htmlContent: '<p>Hello</p>' },
			organizationId: 'org-1',
		};
		const retryState = {
			attempt: 2,
			startedAt: Date.now(),
			idempotencyKey: `send_${sendId!}`,
		};
		const issued = await t.mutation(internal.delivery.routingReentry.issueSnapshot, {
			sendRef: { kind: 'transactional', id: sendId! },
			organizationId: 'org-1',
			messageId: retryState.idempotencyKey,
			workAttemptId: 'transactional-attempt-1',
			envelopeInput,
			retryState,
		});

		expect(issued.token).toMatch(/^rr2\./u);
		expect(issued.expiresAt - retryState.startedAt).toBeLessThanOrEqual(
			GOVERNED_MTA_MAX_MESSAGE_AGE_MS
		);
		const result = await t.mutation(internal.delivery.routingReentry.consumeSnapshot, {
			token: issued.token,
			messageId: retryState.idempotencyKey,
			workAttemptId: 'transactional-attempt-1',
			reason: 'warming_capacity_changed',
			envelopeInput,
			retryState,
		});

		expect(result).toMatchObject({ disposition: 'enqueued' });
		expect(transactionalEnqueueAction).toHaveBeenCalledOnce();
		expect(campaignEnqueueAction).not.toHaveBeenCalled();
		expect(transactionalEnqueueAction.mock.calls[0]?.[3]).toMatchObject({
			context: { sendRef: { kind: 'transactional', id: sendId! } },
		});
		expect(await t.run((ctx) => ctx.db.get(sendId!))).toMatchObject({
			status: 'queued',
			providerMessageId: retryState.idempotencyKey,
			providerType: 'mta',
			mtaRoutingReentryAttempt: 2,
		});
	});
});
