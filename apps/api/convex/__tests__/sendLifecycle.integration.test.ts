import { convexTest } from 'convex-test';
import { describe, it, expect, afterEach } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import {
	createTestCampaign,
	createTestContact,
	createTestEmailSend,
	createTestTransactionalEmail,
} from './factories';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { rollupCampaignStatsRow } from '../campaigns/statShards';

const modules = import.meta.glob('../**/*.*s');

// VERP (Variable Envelope Return-Path) encode/decode — mirrors the SSOT in
// apps/mta/src/bounce/verp.ts (buildVerpAddress / parseVerpAddress). Replicated
// here (not imported) because apps/api does not depend on @owlat/mta; the round-
// trip is asserted directly against the MTA helpers in
// apps/mta/src/bounce/__tests__/verpRoundTrip.test.ts. Both ends must encode the
// SAME token: the send's stored providerMessageId.
function buildVerpAddress(messageId: string, returnPathDomain: string): string {
	return `bounce+${Buffer.from(messageId).toString('base64url')}@${returnPathDomain}`;
}
function parseVerpAddress(address: string): string | null {
	const match = address.match(/^bounce\+([A-Za-z0-9_-]+)@/);
	if (!match?.[1]) return null;
	try {
		return Buffer.from(match[1], 'base64url').toString('utf-8');
	} catch {
		return null;
	}
}

// Campaign send stats are write-sharded; roll the shards into campaigns.stats*
// (what readers see) before reading, since the production rollup is async (cron).
async function readCampaignWithStats(ctx: MutationCtx, campaignId: Id<'campaigns'>) {
	const c = await ctx.db.get(campaignId);
	if (c) await rollupCampaignStatsRow(ctx, c);
	return ctx.db.get(campaignId);
}

// The lifecycle module schedules customer-webhook fanout and reputation
// updates via ctx.scheduler.runAfter(0, ...). Let those scheduled actions
// drain before the next test replaces convex-test's global state — otherwise
// they leak "Write outside of transaction" unhandled rejections.
afterEach(async () => {
	await new Promise((resolve) => setTimeout(resolve, 25));
});

function createTestTransactionalSend(overrides: Record<string, unknown> = {}) {
	const now = Date.now();
	return {
		kind: 'transactional' as const,
		transactionalEmailId: 'placeholder' as unknown as Id<'transactionalEmails'>,
		email: 'user@example.com',
		contactId: undefined,
		status: 'sent' as const,
		providerMessageId: 'tx_msg_default',
		sentAt: now,
		...overrides,
	};
}

// ============================================================================
// transition — worker path
// ============================================================================

describe('sendLifecycle.transition — worker path', () => {
	it('queued -> sent for a campaign send, bumps campaigns.statsSent', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		let sendId: Id<'emailSends'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ statsSent: 0 })
			);
			const contactId = await ctx.db.insert('contacts', createTestContact());
			sendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({ campaignId, contactId, status: 'queued' })
			);
		});

		const outcome = await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: {
				to: 'sent',
				at: Date.now(),
				providerMessageId: 'provider-abc-123',
				providerType: 'mta',
			},
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.applied).toBe('transitioned');
		expect(outcome.from).toBe('queued');
		expect(outcome.to).toBe('sent');

		await t.run(async (ctx) => {
			const send = await ctx.db.get(sendId!);
			expect(send?.status).toBe('sent');
			expect(send?.providerMessageId).toBe('provider-abc-123');
			expect(send?.providerType).toBe('mta');
			const campaign = await readCampaignWithStats(ctx, campaignId!);
			expect(campaign?.statsSent).toBe(1);
		});
	});

	it('queued -> failed writes status, errorMessage, errorCode (fixes legacy bug)', async () => {
		const t = convexTest(schema, modules);
		let sendId: Id<'emailSends'>;
		await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			const contactId = await ctx.db.insert('contacts', createTestContact());
			sendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({ campaignId, contactId, status: 'queued' })
			);
		});

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: {
				to: 'failed',
				at: Date.now(),
				errorMessage: 'connect ETIMEDOUT',
				errorCode: 'WORKPOOL_FAILED',
			},
		});

		await t.run(async (ctx) => {
			const send = await ctx.db.get(sendId!);
			expect(send?.status).toBe('failed'); // status DID change (legacy bug fixed)
			expect(send?.errorMessage).toBe('connect ETIMEDOUT');
			expect(send?.errorCode).toBe('WORKPOOL_FAILED');
		});
	});

	it('sent -> delivered for both kinds', async () => {
		const t = convexTest(schema, modules);
		let campaignSendId: Id<'emailSends'>;
		let txSendId: Id<'transactionalSends'>;
		await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			const contactId = await ctx.db.insert('contacts', createTestContact());
			campaignSendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({ campaignId, contactId, status: 'sent' })
			);
			const transactionalEmailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail()
			);
			txSendId = await ctx.db.insert(
				'transactionalSends',
				createTestTransactionalSend({ transactionalEmailId, status: 'sent' })
			);
		});

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: campaignSendId! },
			transition: { to: 'delivered', at: Date.now() },
		});
		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'transactional', id: txSendId! },
			transition: { to: 'delivered', at: Date.now() },
		});

		await t.run(async (ctx) => {
			expect((await ctx.db.get(campaignSendId!))?.status).toBe('delivered');
			expect((await ctx.db.get(txSendId!))?.status).toBe('delivered');
		});
	});
});

// ============================================================================
// transition — opened / clicked semantics
// ============================================================================

describe('sendLifecycle.transition — delivered', () => {
	it('sent -> delivered stamps deliveredAt and bumps campaigns.statsDelivered exactly once', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		let sendId: Id<'emailSends'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ statsDelivered: 0 })
			);
			const contactId = await ctx.db.insert('contacts', createTestContact());
			sendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({ campaignId, contactId, status: 'sent' })
			);
		});

		const first = await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: { to: 'delivered', at: 1000 },
		});
		// A redundant `delivered` webhook must not double-count.
		const dup = await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: { to: 'delivered', at: 2000 },
		});

		expect(first.ok && first.applied).toBe('transitioned');
		expect(dup.ok && dup.applied).toBe('duplicate');

		await t.run(async (ctx) => {
			const send = await ctx.db.get(sendId!);
			expect(send?.status).toBe('delivered');
			expect(send?.deliveredAt).toBe(1000);
			const campaign = await readCampaignWithStats(ctx, campaignId!);
			// Before the fix this counter was never written (every open/click
			// rate read 0%). It must now bump on the delivered transition only.
			expect(campaign?.statsDelivered).toBe(1);
		});
	});
});

describe('sendLifecycle.transition — opened/clicked', () => {
	it('first open transitions status, bumps campaigns.statsOpened; subsequent opens only increment openCount', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		let sendId: Id<'emailSends'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ statsOpened: 0 })
			);
			const contactId = await ctx.db.insert('contacts', createTestContact());
			sendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({ campaignId, contactId, status: 'delivered' })
			);
		});

		const first = await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: { to: 'opened', at: 1000 },
		});
		const second = await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: { to: 'opened', at: 2000 },
		});
		const third = await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: { to: 'opened', at: 3000 },
		});

		expect(first.ok && first.applied).toBe('transitioned');
		expect(second.ok && second.applied).toBe('recorded');
		expect(third.ok && third.applied).toBe('recorded');

		await t.run(async (ctx) => {
			const send = await ctx.db.get(sendId!);
			expect(send?.status).toBe('opened');
			expect(send?.openCount).toBe(3);
			expect(send?.openedAt).toBe(1000); // pinned to first open
			const campaign = await readCampaignWithStats(ctx, campaignId!);
			expect(campaign?.statsOpened).toBe(1); // bumped once
		});
	});

	it('first click transitions status, bumps campaigns.statsClicked; subsequent clicks append clickedLinks', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		let sendId: Id<'emailSends'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ statsClicked: 0 })
			);
			const contactId = await ctx.db.insert('contacts', createTestContact());
			sendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({ campaignId, contactId, status: 'delivered' })
			);
		});

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: { to: 'clicked', at: 1000, url: 'https://example.com/a' },
		});
		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: { to: 'clicked', at: 2000, url: 'https://example.com/b' },
		});

		await t.run(async (ctx) => {
			const send = await ctx.db.get(sendId!);
			expect(send?.status).toBe('clicked');
			expect(send?.clickedAt).toBe(1000);
			expect(send?.clickedLinks).toHaveLength(2);
			const campaign = await readCampaignWithStats(ctx, campaignId!);
			expect(campaign?.statsClicked).toBe(1); // bumped once
		});
	});

	it('open after bounce records count but does not re-transition out of terminal', async () => {
		const t = convexTest(schema, modules);
		let sendId: Id<'emailSends'>;
		await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			const contactId = await ctx.db.insert('contacts', createTestContact());
			sendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'bounced',
					bouncedAt: 500,
					bounceType: 'hard',
					contactEmail: 'bounce@example.com',
				})
			);
		});

		const outcome = await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: { to: 'opened', at: 1000 },
		});

		// open is illegal from terminal `bounced` (not in LEGAL_EDGES.bounced)
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('terminal');
	});
});

// ============================================================================
// transition — bounce semantics
// ============================================================================

describe('sendLifecycle.transition — bounced', () => {
	it('hard bounce: writes status+bounceType, inserts blocklist, bumps stats, logs activity', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		let contactId: Id<'contacts'>;
		let sendId: Id<'emailSends'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ statsBounced: 0, statsHardBounced: 0 })
			);
			contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'bounce@example.com' })
			);
			sendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'sent',
					contactEmail: 'bounce@example.com',
				})
			);
		});

		const outcome = await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: {
				to: 'bounced',
				at: Date.now(),
				bounceType: 'hard',
				bounceMessage: 'Mailbox does not exist',
			},
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.applied).toBe('transitioned');

		await t.run(async (ctx) => {
			const send = await ctx.db.get(sendId!);
			expect(send?.status).toBe('bounced');
			expect(send?.bounceType).toBe('hard'); // canonical encoding
			expect(send?.errorMessage).toBe('Mailbox does not exist');

			const campaign = await readCampaignWithStats(ctx, campaignId!);
			expect(campaign?.statsBounced).toBe(1);
			expect(campaign?.statsHardBounced).toBe(1);

			const blocked = await ctx.db
				.query('blockedEmails')
				.withIndex('by_email', (q) => q.eq('email', 'bounce@example.com'))
				.first();
			expect(blocked?.reason).toBe('bounced');
			expect(blocked?.bounceType).toBe('hard');

			const activities = await ctx.db
				.query('contactActivities')
				.withIndex('by_contact_and_type', (q) =>
					q.eq('contactId', contactId!).eq('activityType', 'email_bounced')
				)
				.collect();
			expect(activities).toHaveLength(1);
		});
	});

	it('soft bounce: writes status+bounceType, bumps statsSoftBounced, does NOT insert blocklist', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		let sendId: Id<'emailSends'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ statsBounced: 0, statsSoftBounced: 0 })
			);
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'soft@example.com' })
			);
			sendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'sent',
					contactEmail: 'soft@example.com',
				})
			);
		});

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: { to: 'bounced', at: Date.now(), bounceType: 'soft' },
		});

		await t.run(async (ctx) => {
			const send = await ctx.db.get(sendId!);
			expect(send?.status).toBe('bounced');
			expect(send?.bounceType).toBe('soft');
			const campaign = await readCampaignWithStats(ctx, campaignId!);
			expect(campaign?.statsBounced).toBe(1);
			expect(campaign?.statsSoftBounced).toBe(1);
			expect(campaign?.statsHardBounced ?? 0).toBe(0);

			const blocked = await ctx.db
				.query('blockedEmails')
				.withIndex('by_email', (q) => q.eq('email', 'soft@example.com'))
				.first();
			expect(blocked).toBeNull();
		});
	});

	it('transactional bounce: writes bounceType, inserts blocklist, no campaign stats', async () => {
		const t = convexTest(schema, modules);
		let txSendId: Id<'transactionalSends'>;
		await t.run(async (ctx) => {
			const transactionalEmailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail()
			);
			txSendId = await ctx.db.insert(
				'transactionalSends',
				createTestTransactionalSend({
					transactionalEmailId,
					email: 'tx-bounce@example.com',
					status: 'sent',
				})
			);
		});

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'transactional', id: txSendId! },
			transition: { to: 'bounced', at: Date.now(), bounceType: 'hard' },
		});

		await t.run(async (ctx) => {
			const send = await ctx.db.get(txSendId!);
			expect(send?.status).toBe('bounced');
			expect(send?.bounceType).toBe('hard');

			const blocked = await ctx.db
				.query('blockedEmails')
				.withIndex('by_email', (q) => q.eq('email', 'tx-bounce@example.com'))
				.first();
			expect(blocked?.reason).toBe('bounced');
			expect(blocked?.sourceType).toBe('transactionalSend');
		});
	});

	it('duplicate bounce is a no-op (idempotency)', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		let sendId: Id<'emailSends'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ statsBounced: 0 })
			);
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'dup@example.com' })
			);
			sendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'sent',
					contactEmail: 'dup@example.com',
				})
			);
		});

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: { to: 'bounced', at: Date.now(), bounceType: 'hard' },
		});
		const second = await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: { to: 'bounced', at: Date.now(), bounceType: 'hard' },
		});

		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.applied).toBe('duplicate');

		await t.run(async (ctx) => {
			const campaign = await readCampaignWithStats(ctx, campaignId!);
			expect(campaign?.statsBounced).toBe(1); // not double-counted
		});
	});
});

// ============================================================================
// transition — soft-bounce suppression (PR-11)
//
// (1) A single soft bounce must NOT suppress (RFC 3463 transient), but a
//     chronically-4xx recipient must be suppressed after N soft bounces, with
//     the counter resetting on a successful delivery.
// (2) A soft-bounced send is NON-terminal: a later hard bounce hardens it (and
//     blocklists), and a later complaint is recorded + blocklists — neither is
//     rejected 'terminal'.
// ============================================================================

const SOFT_BOUNCE_THRESHOLD = 5;

describe('sendLifecycle.transition — soft-bounce suppression', () => {
	it('repeated soft bounces to the same recipient suppress only at the threshold, and reset on delivered', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		let contactId: Id<'contacts'>;
		const email = 'chronic-soft@example.com';

		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ statsBounced: 0, statsSoftBounced: 0 })
			);
			contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email })
			);
		});

		// Helper: fresh send (one per delivery attempt) to the SAME recipient,
		// transitioned sent -> bounced(soft). The per-recipient counter lives on
		// the contact, so distinct sends accumulate it.
		async function softBounceOnceViaNewSend() {
			let sendId: Id<'emailSends'>;
			await t.run(async (ctx) => {
				sendId = await ctx.db.insert(
					'emailSends',
					createTestEmailSend({
						campaignId: campaignId!,
						contactId: contactId!,
						status: 'sent',
						contactEmail: email,
					})
				);
			});
			return t.mutation(internal.delivery.sendLifecycle.transition, {
				send: { kind: 'campaign', id: sendId! },
				transition: { to: 'bounced', at: Date.now(), bounceType: 'soft' },
			});
		}

		// First THRESHOLD-1 soft bounces: counter advances, NO blocklist row yet.
		for (let i = 1; i < SOFT_BOUNCE_THRESHOLD; i++) {
			const outcome = await softBounceOnceViaNewSend();
			expect(outcome.ok).toBe(true);
			await t.run(async (ctx) => {
				const contact = await ctx.db.get(contactId!);
				expect(contact?.softBounceCount).toBe(i);
				const blocked = await ctx.db
					.query('blockedEmails')
					.withIndex('by_email', (q) => q.eq('email', email))
					.collect();
				expect(blocked).toHaveLength(0);
			});
		}

		// The Nth (threshold) soft bounce escalates: exactly ONE blocklist row.
		await softBounceOnceViaNewSend();
		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId!);
			expect(contact?.softBounceCount).toBe(SOFT_BOUNCE_THRESHOLD);
			const blocked = await ctx.db
				.query('blockedEmails')
				.withIndex('by_email', (q) => q.eq('email', email))
				.collect();
			expect(blocked).toHaveLength(1);
			expect(blocked[0]!.reason).toBe('bounced');
			expect(blocked[0]!.bounceType).toBe('soft');
		});

		// A successful delivery proves the address recovered → counter resets to 0.
		await t.run(async (ctx) => {
			const recoveredSendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId: campaignId!,
					contactId: contactId!,
					status: 'sent',
					contactEmail: email,
				})
			);
			await t.mutation(internal.delivery.sendLifecycle.transition, {
				send: { kind: 'campaign', id: recoveredSendId },
				transition: { to: 'delivered', at: Date.now() },
			});
		});
		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId!);
			expect(contact?.softBounceCount).toBe(0);
		});
	});

	it('a repeat soft bounce on the SAME send does not double-count the recipient counter', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;
		let sendId: Id<'emailSends'>;
		const email = 'retry-soft@example.com';
		await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			contactId = await ctx.db.insert('contacts', createTestContact({ email }));
			sendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'sent',
					contactEmail: email,
				})
			);
		});

		const first = await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: { to: 'bounced', at: 1000, bounceType: 'soft' },
		});
		// Retried/duplicate soft webhook for the SAME send.
		const repeat = await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: { to: 'bounced', at: 2000, bounceType: 'soft' },
		});

		expect(first.ok && first.applied).toBe('transitioned');
		expect(repeat.ok && repeat.applied).toBe('duplicate');

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId!);
			expect(contact?.softBounceCount).toBe(1); // bumped once, not twice
		});
	});

	it('soft bounce then HARD bounce on the same send is APPLIED (hardens + blocklists), not refused terminal', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		let sendId: Id<'emailSends'>;
		const email = 'soft-then-hard@example.com';
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ statsBounced: 0, statsHardBounced: 0, statsSoftBounced: 0 })
			);
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email })
			);
			sendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'sent',
					contactEmail: email,
				})
			);
		});

		const soft = await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: { to: 'bounced', at: 1000, bounceType: 'soft' },
		});
		expect(soft.ok).toBe(true);

		// No blocklist yet (one soft bounce, below threshold).
		await t.run(async (ctx) => {
			const blocked = await ctx.db
				.query('blockedEmails')
				.withIndex('by_email', (q) => q.eq('email', email))
				.first();
			expect(blocked).toBeNull();
		});

		// A subsequent HARD bounce on the SAME (soft-bounced) send must be
		// APPLIED — before the fix LEGAL_EDGES.bounced was empty and this was
		// rejected 'terminal' and lost.
		const hard = await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: {
				to: 'bounced',
				at: 2000,
				bounceType: 'hard',
				bounceMessage: 'Mailbox does not exist',
			},
		});

		expect(hard.ok).toBe(true);
		if (!hard.ok) return;
		expect(hard.applied).toBe('transitioned');
		expect(hard.from).toBe('bounced');

		await t.run(async (ctx) => {
			const send = await ctx.db.get(sendId!);
			expect(send?.status).toBe('bounced');
			expect(send?.bounceType).toBe('hard'); // hardened
			expect(send?.errorMessage).toBe('Mailbox does not exist');

			const blocked = await ctx.db
				.query('blockedEmails')
				.withIndex('by_email', (q) => q.eq('email', email))
				.collect();
			expect(blocked).toHaveLength(1); // exactly one row, hard
			expect(blocked[0]!.reason).toBe('bounced');
			expect(blocked[0]!.bounceType).toBe('hard');

			const campaign = await readCampaignWithStats(ctx, campaignId!);
			expect(campaign?.statsHardBounced).toBe(1);
		});
	});

	it('soft bounce then COMPLAINT on the same send is recorded + blocklisted, not refused terminal', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;
		let sendId: Id<'emailSends'>;
		const email = 'soft-then-complaint@example.com';
		await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			contactId = await ctx.db.insert('contacts', createTestContact({ email }));
			sendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'sent',
					contactEmail: email,
				})
			);
		});

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: { to: 'bounced', at: 1000, bounceType: 'soft' },
		});

		const complaint = await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: { to: 'complained', at: 2000 },
		});

		expect(complaint.ok).toBe(true);
		if (!complaint.ok) return;
		expect(complaint.applied).toBe('transitioned');
		expect(complaint.from).toBe('bounced');

		await t.run(async (ctx) => {
			const send = await ctx.db.get(sendId!);
			expect(send?.status).toBe('complained');

			const blocked = await ctx.db
				.query('blockedEmails')
				.withIndex('by_email', (q) => q.eq('email', email))
				.first();
			expect(blocked?.reason).toBe('complained');

			const activities = await ctx.db
				.query('contactActivities')
				.withIndex('by_contact_and_type', (q) =>
					q.eq('contactId', contactId!).eq('activityType', 'email_complained')
				)
				.collect();
			expect(activities).toHaveLength(1);
		});
	});

	it('a HARD bounce stays terminal — a later soft bounce is a no-op', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;
		let sendId: Id<'emailSends'>;
		const email = 'hard-then-soft@example.com';
		await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			contactId = await ctx.db.insert('contacts', createTestContact({ email }));
			sendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'bounced',
					bouncedAt: 100,
					bounceType: 'hard',
					contactEmail: email,
				})
			);
		});

		const outcome = await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: { to: 'bounced', at: 2000, bounceType: 'soft' },
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.applied).toBe('duplicate'); // terminal hard, no-op

		await t.run(async (ctx) => {
			const send = await ctx.db.get(sendId!);
			expect(send?.bounceType).toBe('hard'); // unchanged
			const contact = await ctx.db.get(contactId!);
			// the soft counter must NOT advance off a permanently-dead row
			expect(contact?.softBounceCount ?? 0).toBe(0);
		});
	});
});

// ============================================================================
// transition — complaint semantics
// ============================================================================

describe('sendLifecycle.transition — complained', () => {
	it('complaint: status+complainedAt, inserts blocklist, flags content scan, logs activity', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		let contactId: Id<'contacts'>;
		let sendId: Id<'emailSends'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'spam@example.com' })
			);
			sendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'sent',
					contactEmail: 'spam@example.com',
				})
			);
			await ctx.db.insert('contentScanResults', {
				resourceType: 'campaign',
				resourceId: campaignId,
				score: 10,
				level: 'clean',
				flags: [],
				scannedAt: Date.now(),
			});
		});

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: { to: 'complained', at: Date.now() },
		});

		await t.run(async (ctx) => {
			const send = await ctx.db.get(sendId!);
			expect(send?.status).toBe('complained');
			expect(send?.complainedAt).toBeTypeOf('number');

			const blocked = await ctx.db
				.query('blockedEmails')
				.withIndex('by_email', (q) => q.eq('email', 'spam@example.com'))
				.first();
			expect(blocked?.reason).toBe('complained');

			const scan = await ctx.db
				.query('contentScanResults')
				.withIndex('by_resource', (q) =>
					q.eq('resourceType', 'campaign').eq('resourceId', campaignId!)
				)
				.first();
			expect(scan?.flags).toHaveLength(1);
			expect(scan?.flags[0]!.type).toBe('suspicious_pattern');

			const activities = await ctx.db
				.query('contactActivities')
				.withIndex('by_contact_and_type', (q) =>
					q.eq('contactId', contactId!).eq('activityType', 'email_complained')
				)
				.collect();
			expect(activities).toHaveLength(1);
		});
	});

	// PR-13: when an ARF complaint carries only a recipient address (no
	// recoverable Message-ID — e.g. Gmail FBL redaction), the complaint still
	// has to land the recipient on the blocklist. The MTA → webhook path emits
	// a recipient-only complained event that the dispatcher routes straight to
	// blockedEmails.addFromEvent. This integration test asserts the row lands.
	it('recipient-only complaint inserts a blockedEmails row with reason "complained"', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(internal.blockedEmails.addFromEvent, {
			email: 'Victim@Example.com',
			reason: 'complained',
		});

		await t.run(async (ctx) => {
			const blocked = await ctx.db
				.query('blockedEmails')
				// addFromEvent normalizes (lowercase + trim) before insert.
				.withIndex('by_email', (q) => q.eq('email', 'victim@example.com'))
				.first();
			expect(blocked).not.toBeNull();
			expect(blocked?.reason).toBe('complained');
			// No source send — the recipient was suppressed by address alone.
			expect(blocked?.sourceType).toBeUndefined();
			expect(blocked?.sourceEmailSendId).toBeUndefined();
			expect(blocked?.sourceTransactionalSendId).toBeUndefined();
		});
	});

	it('recipient-only complaint is idempotent (no duplicate blocklist row)', async () => {
		const t = convexTest(schema, modules);

		const first = await t.mutation(internal.blockedEmails.addFromEvent, {
			email: 'dup@example.com',
			reason: 'complained',
		});
		const second = await t.mutation(internal.blockedEmails.addFromEvent, {
			email: 'dup@example.com',
			reason: 'complained',
		});
		expect(second).toBe(first);

		await t.run(async (ctx) => {
			const rows = await ctx.db
				.query('blockedEmails')
				.withIndex('by_email', (q) => q.eq('email', 'dup@example.com'))
				.collect();
			expect(rows).toHaveLength(1);
		});
	});
});

// ============================================================================
// Legal-edges enforcement
// ============================================================================

describe('sendLifecycle.transition — legal-edges enforcement', () => {
	it('bounced -> complained is refused (terminal)', async () => {
		const t = convexTest(schema, modules);
		let sendId: Id<'emailSends'>;
		await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'refused@example.com' })
			);
			sendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'bounced',
					bouncedAt: 100,
					bounceType: 'hard',
					contactEmail: 'refused@example.com',
				})
			);
		});

		const outcome = await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: { to: 'complained', at: Date.now() },
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('terminal');
		expect(outcome.from).toBe('bounced');
	});

	it('complained -> bounced is refused (terminal)', async () => {
		const t = convexTest(schema, modules);
		let sendId: Id<'emailSends'>;
		await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			const contactId = await ctx.db.insert('contacts', createTestContact());
			sendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'complained',
					complainedAt: 100,
				})
			);
		});

		const outcome = await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: { to: 'bounced', at: Date.now(), bounceType: 'hard' },
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('terminal');
	});

	it('queued -> delivered is illegal (must go through sent)', async () => {
		const t = convexTest(schema, modules);
		let sendId: Id<'emailSends'>;
		await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			const contactId = await ctx.db.insert('contacts', createTestContact());
			sendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({ campaignId, contactId, status: 'queued' })
			);
		});

		const outcome = await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: { to: 'delivered', at: Date.now() },
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('illegal_edge');
	});

	it('transactional queued -> sent is legal post-α (ADR-0006)', async () => {
		// Pre-ADR-0006, transactional sends were created directly in `sent`
		// by `transactionalSends.createInternal`; the lifecycle rejected
		// `to:'sent'` for transactional as `invalid_for_kind`. Post-α,
		// transactional rows pre-create in `queued` and walk the same
		// `queued → sent` edge campaign sends do.
		const t = convexTest(schema, modules);
		let txSendId: Id<'transactionalSends'>;
		await t.run(async (ctx) => {
			const transactionalEmailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail()
			);
			txSendId = await ctx.db.insert('transactionalSends', {
				kind: 'transactional' as const,
				transactionalEmailId,
				email: 'user@example.com',
				status: 'queued' as const,
				queuedAt: Date.now(),
			});
		});

		const outcome = await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'transactional', id: txSendId! },
			transition: {
				to: 'sent',
				at: Date.now(),
				providerMessageId: 'tx_msg_post_alpha',
			},
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.applied).toBe('transitioned');
		expect(outcome.from).toBe('queued');
		expect(outcome.to).toBe('sent');

		await t.run(async (ctx) => {
			const send = await ctx.db.get(txSendId!);
			expect(send?.status).toBe('sent');
			expect(send?.providerMessageId).toBe('tx_msg_post_alpha');
		});
	});
});

// ============================================================================
// transitionByProviderMessageId
// ============================================================================

describe('sendLifecycle.transitionByProviderMessageId', () => {
	it('resolves a campaign send and applies the transition', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			const contactId = await ctx.db.insert('contacts', createTestContact());
			await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					providerMessageId: 'msg_lookup_001',
					status: 'sent',
					contactEmail: 'lookup@example.com',
				})
			);
		});

		const outcome = await t.mutation(
			internal.delivery.sendLifecycle.transitionByProviderMessageId,
			{
				providerMessageId: 'msg_lookup_001',
				transition: { to: 'bounced', at: Date.now(), bounceType: 'soft' },
			}
		);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.to).toBe('bounced');
	});

	it('resolves a transactional send when no campaign send matches', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const transactionalEmailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail()
			);
			await ctx.db.insert(
				'transactionalSends',
				createTestTransactionalSend({
					transactionalEmailId,
					providerMessageId: 'msg_tx_002',
					email: 'tx-lookup@example.com',
					status: 'sent',
				})
			);
		});

		const outcome = await t.mutation(
			internal.delivery.sendLifecycle.transitionByProviderMessageId,
			{
				providerMessageId: 'msg_tx_002',
				transition: { to: 'complained', at: Date.now() },
			}
		);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.to).toBe('complained');
	});

	it('returns ok:false reason:send_not_found for unknown providerMessageId', async () => {
		const t = convexTest(schema, modules);

		const outcome = await t.mutation(
			internal.delivery.sendLifecycle.transitionByProviderMessageId,
			{
				providerMessageId: 'msg_does_not_exist',
				transition: { to: 'bounced', at: Date.now(), bounceType: 'hard' },
			}
		);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('send_not_found');
	});
});

// ============================================================================
// Async-DSN attribution end-to-end (audit PR-01)
// ============================================================================
//
// The full chain the /send jobId fix protects:
//   1. worker stores providerMessageId === messageId === `send_<emailSendId>`
//   2. MTA encodes that messageId into the VERP Return-Path
//   3. async bounce DSN lands on the VERP address; the token is decoded back
//   4. dispatcher calls transitionByProviderMessageId with the decoded token,
//      which resolves the send by_provider_message_id → bounced + blocklist
//
// Before the fix, step 1 stored a random groupmq UUID instead of the messageId,
// so the decoded VERP token (step 3) never matched any stored providerMessageId
// and step 4 returned send_not_found — every post-acceptance bounce was dropped.

describe('async-DSN attribution end-to-end (PR-01)', () => {
	it('VERP-decoded send_<emailSendId> drives bounced + blocklist insert', async () => {
		const t = convexTest(schema, modules);
		let emailSendId: Id<'emailSends'>;
		const bouncedEmail = 'async-bounce@example.com';

		await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: bouncedEmail })
			);
			emailSendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'sent',
					contactEmail: bouncedEmail,
				})
			);
			// What the worker stores AFTER the /send jobId fix: providerMessageId
			// equals the messageId the MTA echoed back, which is `send_<rowId>`.
			await ctx.db.patch(emailSendId, {
				providerMessageId: `send_${emailSendId}`,
			});
		});

		const storedProviderMessageId = `send_${emailSendId!}`;

		// The MTA stamps this stored id into the VERP Return-Path; the async DSN
		// bounces to it and the token is decoded back out (parseBounce → verp).
		const verp = buildVerpAddress(storedProviderMessageId, 'bounces.test');
		const decoded = parseVerpAddress(verp);
		expect(decoded).toBe(storedProviderMessageId);

		// Dispatch the bounce keyed on the VERP-decoded token, exactly as
		// webhooks/dispatcher.ts does for an `email.bounced` inbound event.
		const outcome = await t.mutation(
			internal.delivery.sendLifecycle.transitionByProviderMessageId,
			{
				providerMessageId: decoded!,
				transition: { to: 'bounced', at: Date.now(), bounceType: 'hard' },
			}
		);

		// The send is found and bounced — NOT send_not_found.
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.applied).toBe('transitioned');
		expect(outcome.to).toBe('bounced');

		await t.run(async (ctx) => {
			const send = await ctx.db.get(emailSendId!);
			expect(send?.status).toBe('bounced');
			expect(send?.bounceType).toBe('hard');

			// Hard bounce suppresses the address — the whole point of attributing
			// the DSN (otherwise we keep mailing a dead inbox and tank reputation).
			const blocked = await ctx.db
				.query('blockedEmails')
				.withIndex('by_email', (q) => q.eq('email', bouncedEmail))
				.first();
			expect(blocked?.reason).toBe('bounced');
			expect(blocked?.bounceType).toBe('hard');
			expect(blocked?.sourceType).toBe('emailSend');
		});
	});
});
