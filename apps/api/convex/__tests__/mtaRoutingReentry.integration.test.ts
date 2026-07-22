import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { createTestCampaign, createTestContact, createTestEmailSend } from './factories';

const enqueueAction = vi.fn().mockResolvedValue('work-1');
vi.mock('../delivery/workpool', () => ({
	campaignEmailPool: { enqueueAction },
	transactionalEmailPool: { enqueueAction },
}));

const modules = import.meta.glob('../**/*.*s');

beforeEach(() => enqueueAction.mockClear());

describe('accepted MTA routing re-entry', () => {
	it('atomically enqueues one retry for duplicate callbacks with the same Send/idempotency key', async () => {
		const t = convexTest(schema, modules);
		const sendId = await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			const contactId = await ctx.db.insert('contacts', createTestContact());
			return await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'sent',
					providerMessageId: `send_pending`,
				})
			);
		});
		const args = {
			sendRef: { kind: 'campaign' as const, id: sendId },
			messageId: 'send_pending',
			envelopeInput: {
				kind: 'campaign',
				to: 'person@example.com',
				from: 'sender@example.org',
			},
			retryState: {
				attempt: 1,
				startedAt: Date.now(),
				idempotencyKey: 'send_pending',
			},
			reason: 'breaker generation changed',
		};

		const first = await t.mutation(internal.delivery.sendCompletion.reenterAcceptedMtaSend, args);
		const duplicate = await t.mutation(
			internal.delivery.sendCompletion.reenterAcceptedMtaSend,
			args
		);

		expect(first).toMatchObject({ disposition: 'enqueued' });
		expect(duplicate).toEqual({ disposition: 'duplicate_or_expired' });
		expect(enqueueAction).toHaveBeenCalledOnce();
		expect(enqueueAction).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({
				retryState: expect.objectContaining({ idempotencyKey: 'send_pending' }),
			}),
			expect.objectContaining({
				context: { sendRef: { kind: 'campaign', id: sendId } },
			})
		);
		expect(await t.run((ctx) => ctx.db.get(sendId))).toMatchObject({
			status: 'sent',
			providerMessageId: 'send_pending',
			mtaRoutingReentryAttempt: 1,
		});
	});
});
