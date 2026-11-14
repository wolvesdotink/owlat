/**
 * Test-send commit (module) — the ONE write of the test-send actions
 * (`campaigns/testSend.ts`).
 *
 * The actions read the campaign or take the editor's content and compose the
 * preview. Every gate, and the queued Sends, are then one transaction, in
 * this order:
 *
 *   0. the sending domain is verified. Checked here rather than in the action
 *      so a domain that loses verification before the commit queues nothing;
 *      refused before any write, as no token should be spent on it;
 *   1. the curated-sender gate: a test send uses the same From a real send
 *      would, so it is held to the same list/toggle rule as the campaign
 *      pre-flight. The org default sender is seeded first, so an upgraded
 *      deployment (empty list, toggle off) can still test from its own default
 *      address; the seed is idempotent;
 *   2. the per-user rate limit, so the 5-recipient cap cannot be looped into a
 *      volume that burns the sending domain's reputation;
 *   3. the recipient allowlist: test sends emit real, unscanned,
 *      caller-controlled HTML from the verified domain, so they may only go to
 *      the org's own member inboxes, never relay to an arbitrary address;
 *   4. a ready delivery provider;
 *   5. one queued test Send per recipient, with its retention callback.
 *
 * A refusal is returned, not thrown, so what the gates before it wrote stands:
 * a refused recipient or a missing provider still spends the token, as a
 * refused relay attempt should. All recipients are queued or none is.
 */

import { v } from 'convex/values';
import { normalizeEmail } from '@owlat/shared';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { internalMutation } from '../lib/writeFence';
import { requireOrgMember } from '../lib/sessionOrganization';
import { rateLimiter } from '../lib/rateLimiter';
import { checkEmailDomainVerification } from '../domains/domains';
import { selectedSendProviderReady } from '../lib/sendProviders/capability';
import {
	NO_TEST_SEND_PROVIDER_MESSAGE,
	TEST_SEND_RETENTION_MS,
	queueTestSend,
} from '../delivery/enqueueTestSend';
import { isCampaignSenderAllowed, seedDefaultSenderIfNeeded } from './senders';
import { loadTransactionalSender } from '../transactional/senderResolution';
import { formatFromAddress } from '../lib/emailProviders/domainVerification';
import { readMemberInboxes } from './sendQueries';

/** Outcome of one commit, mapped onto the action's answer by the action. */
export type TestSendCommit =
	| { kind: 'queued'; sendIds: Id<'transactionalSends'>[] }
	| { kind: 'domain_not_verified'; message: string }
	| { kind: 'sender_not_allowed' }
	| { kind: 'rate_limited'; retryAfter?: number }
	| { kind: 'recipient_not_member'; email: string }
	| { kind: 'no_provider'; message: string };

export const commitTestSends = internalMutation({
	args: {
		/** The bare From address the curated-sender gate checks. */
		fromEmail: v.string(),
		/** The From header the preview goes out with. */
		from: v.string(),
		replyTo: v.optional(v.string()),
		subject: v.string(),
		html: v.string(),
		text: v.optional(v.string()),
		headers: v.optional(v.record(v.string(), v.string())),
		recipients: v.array(v.string()),
		/**
		 * A transactional email's test: it goes out from the sender its real
		 * sends resolve to, read here rather than taken from the caller, and the
		 * campaign-sender list does not apply to it.
		 */
		transactionalEmailId: v.optional(v.id('transactionalEmails')),
	},
	handler: async (ctx, args): Promise<TestSendCommit> => {
		const session = await requireOrgMember(ctx);

		let { fromEmail, from } = args;
		if (args.transactionalEmailId) {
			const sender = await loadTransactionalSender(ctx, {
				template: await ctx.db.get(args.transactionalEmailId),
			});
			if (sender.address === null) {
				return {
					kind: 'domain_not_verified',
					message: 'Cannot send test email: no sender is configured for transactional mail.',
				};
			}
			fromEmail = sender.address;
			from = formatFromAddress(sender.address, sender.name ?? undefined);
		}

		const domain = await checkEmailDomainVerification(ctx, fromEmail);
		if (!domain.verified) {
			return {
				kind: 'domain_not_verified',
				message:
					domain.error ||
					`Cannot send test email: domain "${domain.domain}" is not verified. Please verify this domain in Settings > Domains.`,
			};
		}

		if (!args.transactionalEmailId) {
			await seedDefaultSenderIfNeeded(ctx);
			if (!(await isCampaignSenderAllowed(ctx, fromEmail))) {
				return { kind: 'sender_not_allowed' };
			}
		}

		const limit = await rateLimiter.limit(ctx, 'testEmailSend', { key: session.userId });
		if (!limit.ok) return { kind: 'rate_limited', retryAfter: limit.retryAfter };

		const members = new Set(await readMemberInboxes(ctx));
		const outsider = args.recipients.find((email) => !members.has(normalizeEmail(email)));
		if (outsider !== undefined) return { kind: 'recipient_not_member', email: outsider };

		if (!(await selectedSendProviderReady(ctx, undefined))) {
			return { kind: 'no_provider', message: NO_TEST_SEND_PROVIDER_MESSAGE };
		}

		const sendIds: Id<'transactionalSends'>[] = [];
		for (const email of args.recipients) {
			const queued = await queueTestSend(ctx, {
				email,
				organizationId: session.activeOrganizationId,
				from,
				replyTo: args.replyTo,
				subject: args.subject,
				html: args.html,
				...(args.text !== undefined ? { text: args.text } : {}),
				...(args.headers !== undefined ? { headers: args.headers } : {}),
			});
			await ctx.scheduler.runAfter(
				TEST_SEND_RETENTION_MS,
				internal.delivery.enqueueTestSend.deleteExpiredTestSend,
				queued
			);
			sendIds.push(queued.sendId);
		}
		return { kind: 'queued', sendIds };
	},
});
