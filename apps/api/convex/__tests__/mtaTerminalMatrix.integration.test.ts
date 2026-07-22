import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	createTestCampaign,
	createTestContact,
	createTestEmailSend,
	createTestInboundMessage,
} from './factories';
import { rollupCampaignStatsRow } from '../campaigns/statShards';
import type { ActionCtx } from '../_generated/server';
import { dispatchInboundEvent } from '../webhooks/dispatcher';

const modules = import.meta.glob('../**/*.*s');

afterEach(async () => {
	await new Promise((resolve) => setTimeout(resolve, 25));
});

type Source = 'campaign' | 'agent_reply' | 'member_test';
type Terminal = 'delivered' | 'bounced' | 'failed';

async function seed(source: Source) {
	const t = convexTest(schema, modules);
	let ref:
		| { kind: 'campaign'; id: Id<'emailSends'> }
		| { kind: 'transactional'; id: Id<'transactionalSends'> };
	let campaignId: Id<'campaigns'> | undefined;
	let inboundMessageId: Id<'inboundMessages'> | undefined;
	await t.run(async (ctx) => {
		if (source === 'campaign') {
			campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			const contactId = await ctx.db.insert('contacts', createTestContact());
			const sendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'queued',
					providerMessageId: undefined,
					providerType: undefined,
				})
			);
			ref = { kind: 'campaign', id: sendId };
			return;
		}
		inboundMessageId =
			source === 'agent_reply'
				? await ctx.db.insert(
						'inboundMessages',
						createTestInboundMessage({
							threadId: undefined,
							contactId: undefined,
							processingStatus: 'approved',
						})
					)
				: undefined;
		const sendId = await ctx.db.insert('transactionalSends', {
			kind: source === 'agent_reply' ? ('agent_reply' as const) : ('test' as const),
			email: 'recipient@example.com',
			status: 'queued' as const,
			queuedAt: Date.now(),
			...(inboundMessageId ? { inboundMessageId, subject: 'Re: hello' } : {}),
		});
		ref = { kind: 'transactional', id: sendId };
	});
	return { t, ref: ref!, campaignId, inboundMessageId };
}

describe('MTA post-intake terminal matrix', () => {
	it.each(
		(['campaign', 'agent_reply', 'member_test'] as const).flatMap((source) =>
			(['delivered', 'bounced', 'failed'] as const).flatMap((terminal) =>
				(['completion-first', 'callback-first'] as const).map((order) => ({
					source,
					terminal,
					order,
				}))
			)
		)
	)(
		'$source reaches exactly one $terminal result ($order) and duplicate evidence is inert',
		async ({ source, terminal, order }) => {
			const value = await seed(source);
			const providerMessageId = `send_${source}_${terminal}`;
			expect(
				await value.t.mutation(internal.delivery.sendLifecycle.bindMtaProviderIdentity, {
					send: value.ref,
					providerMessageId,
				})
			).toEqual({ ok: true });

			const apply = async () => {
				if (terminal === 'delivered') {
					return await value.t.mutation(internal.delivery.sendLifecycle.recordMtaRemoteAcceptance, {
						providerMessageId,
						at: 1_700_000_000_000,
					});
				}
				return await value.t.mutation(
					internal.delivery.sendLifecycle.transitionMtaByProviderMessageId,
					{
						providerMessageId,
						transition:
							terminal === 'bounced'
								? {
										to: 'bounced' as const,
										at: 1_700_000_000_000,
										bounceType: 'hard' as const,
										bounceMessage: '550 no such user',
									}
								: {
										to: 'failed' as const,
										at: 1_700_000_000_000,
										errorMessage: 'screened or ambiguous',
										errorCode: 'MTA_TERMINAL_FAILURE',
									},
					}
				);
			};
			const complete = async () =>
				await value.t.mutation(internal.delivery.sendCompletion.completeSend, {
					workId: `work-${source}-${terminal}-${order}` as never,
					result: {
						kind: 'success',
						returnValue: {
							success: true,
							providerMessageId,
							providerType: 'mta',
							acceptedForDelivery: true,
						},
					},
					context: { sendRef: value.ref },
				});

			if (order === 'completion-first') await complete();
			const first = await apply();
			if (order === 'callback-first') await complete();
			const duplicate = await apply();
			expect(first).toMatchObject({ ok: true });
			expect(duplicate).toMatchObject({ ok: true, applied: 'duplicate' });
			expect(await value.t.run((ctx) => ctx.db.get(value.ref.id))).toMatchObject({
				status: terminal,
				providerMessageId,
				providerType: 'mta',
			});

			if (value.inboundMessageId) {
				expect(await value.t.run((ctx) => ctx.db.get(value.inboundMessageId!))).toMatchObject({
					processingStatus: terminal === 'delivered' ? 'sent' : 'failed',
				});
			}
			if (source === 'member_test') {
				await value.t.run(async (ctx) => {
					expect(await ctx.db.query('blockedEmails').collect()).toHaveLength(0);
					expect(await ctx.db.query('sendingReputation').collect()).toHaveLength(0);
				});
			}
			if (value.campaignId) {
				await value.t.run(async (ctx) => {
					const campaign = await ctx.db.get(value.campaignId! as Id<'campaigns'>);
					if (campaign) await rollupCampaignStatsRow(ctx, campaign);
					const updated = await ctx.db.get(value.campaignId! as Id<'campaigns'>);
					expect(updated?.statsSent).toBe(terminal === 'delivered' ? 1 : 0);
					expect(updated?.statsDelivered).toBe(terminal === 'delivered' ? 1 : 0);
					expect(updated?.statsBounced).toBe(terminal === 'bounced' ? 1 : 0);
					expect(updated?.statsFailed).toBe(terminal === 'failed' ? 1 : 0);
				});
			}
		}
	);
});

describe('member-test delayed FBL isolation', () => {
	it('keeps Message-ID and redacted-recipient complaints out of suppression and reputation', async () => {
		const value = await seed('member_test');
		const providerMessageId = 'send_member_delayed_fbl';
		await value.t.mutation(internal.delivery.sendLifecycle.bindMtaProviderIdentity, {
			send: value.ref,
			providerMessageId,
		});
		const ctx = {
			runMutation: (mutation: Parameters<ActionCtx['runMutation']>[0], args: unknown) =>
				value.t.mutation(mutation, args),
		} as unknown as ActionCtx;

		await dispatchInboundEvent(ctx, {
			kind: 'email.complained',
			providerMessageId,
			providerType: 'mta',
			deliveryDomain: 'member_test',
			at: 1_700_000_000_000,
		});
		await dispatchInboundEvent(ctx, {
			kind: 'email.complained',
			recipient: 'recipient@example.com',
			deliveryDomain: 'member_test',
			at: 1_700_000_000_001,
		});

		expect(await value.t.run((dbCtx) => dbCtx.db.get(value.ref.id))).toMatchObject({
			status: 'complained',
		});
		await value.t.run(async (dbCtx) => {
			expect(await dbCtx.db.query('blockedEmails').collect()).toHaveLength(0);
			expect(await dbCtx.db.query('sendingReputation').collect()).toHaveLength(0);
		});
	});
});

describe('acceptance_unknown callback ordering', () => {
	it.each(['completion-first', 'callback-first'] as const)(
		'reuses the same work attempt without failing or rescheduling a terminal Send (%s)',
		async (order) => {
			const value = await seed('campaign');
			const providerMessageId = `send_unknown_${order}`;
			await value.t.mutation(internal.delivery.sendLifecycle.bindMtaProviderIdentity, {
				send: value.ref,
				providerMessageId,
			});
			const completion = () =>
				value.t.mutation(internal.delivery.sendCompletion.completeSend, {
					workId: `unknown-${order}` as never,
					result: {
						kind: 'success' as const,
						returnValue: {
							success: false,
							acceptanceUnknown: true as const,
							providerMessageId,
							workAttemptId: 'same-work-attempt',
							startedAt: Date.now(),
							envelopeInput: {
								kind: 'campaign' as const,
								to: 'recipient@example.com',
								from: 'sender@example.org',
								template: { subject: 'Subject', htmlContent: '<p>Body</p>' },
								contactInfo: { email: 'recipient@example.com' },
								emailSendId: value.ref.id as Id<'emailSends'>,
							},
							retryState: {
								attempt: 1,
								startedAt: Date.now(),
								idempotencyKey: providerMessageId,
								workAttemptId: 'same-work-attempt',
								acceptanceReconciliation: true,
							},
						},
					},
					context: { sendRef: value.ref },
				});
			const callback = () =>
				value.t.mutation(internal.delivery.sendLifecycle.recordMtaRemoteAcceptance, {
					providerMessageId,
					at: Date.now(),
				});

			if (order === 'completion-first') await completion();
			await callback();
			if (order === 'callback-first') await completion();
			const send = await value.t.run((ctx) => ctx.db.get(value.ref.id));
			expect(send).toMatchObject({ status: 'delivered' });
			expect(send?.errorCode).toBeUndefined();
			const retries = await value.t.run(async (ctx) =>
				(await ctx.db.system.query('_scheduled_functions').collect()).filter((job) =>
					job.name.includes('retrySend')
				)
			);
			expect(retries).toHaveLength(order === 'completion-first' ? 1 : 0);
			if (retries[0]) {
				expect(retries[0].args[0]?.retryState).toMatchObject({
					workAttemptId: 'same-work-attempt',
					acceptanceReconciliation: true,
				});
			}
		}
	);
});
