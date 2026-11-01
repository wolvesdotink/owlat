/**
 * The admin delivery TEST SEND — the action half of the Settings → Delivery
 * status surface, split out of `delivery/status.ts` (which had grown past the
 * ~500 LOC split guideline in CONVENTIONS.md). Its sibling keeps the read side
 * (`getStatus`, `getProviderFeedbackStatus`, `getTransportSummary`) and the
 * `recordTestResult` writer this action calls once a send is accepted.
 *
 * Everything here exists to answer one question with a real message on the
 * wire: does the configured provider actually accept mail from this instance?
 * The stage model (`./deliveryTestDecision`) is the shape of that answer.
 */

import { v } from 'convex/values';
import { authedAction } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { getOptional } from '../lib/env';
import { isSendProviderKind } from '../lib/sendProviders/types';
import { throwInternal } from '../_utils/errors';
import {
	nextDeliveryTestStep,
	type DeliveryTestFacts,
	type DeliveryTestResult,
} from './deliveryTestDecision';

/**
 * Send a real test email through the configured delivery provider, so an admin
 * can trace the send path through provider acceptance before trusting it with a
 * campaign or transactional traffic. Reuses the single system transport
 * (`internal.maintenance.systemMail.sendSystemEmail`) — it routes through whatever
 * transport `EMAIL_PROVIDER` names in the composed send-provider registry,
 * built-in or plugin-contributed; this does NOT add a parallel sender. Records
 * a success timestamp for the status page and onboarding surface.
 *
 * Returns a stage-by-stage trace rather than throwing on an expected provider
 * failure, including the safe provider receipt metadata. Acceptance is not
 * called delivery: the recipient inbox or provider feedback confirms that later.
 *
 * Read, send, commit once: `./deliveryTestDecision` names each step from what
 * the earlier ones returned, and the readiness record is the one write after
 * the provider call.
 */
// authz: admin floor enforced via internal.auth.membership.assertOrgAdmin
// (organization:manage) inside the handler — actions can't call
// requireOrgPermission directly.
export const sendTest = authedAction({
	args: { to: v.string() },
	handler: async (ctx, args): Promise<DeliveryTestResult> => {
		// Admin floor (organization:manage) — actions can't run requireOrgPermission
		// directly, so assert through the internal query that inherits our identity.
		await ctx.runQuery(internal.auth.membership.assertOrgAdmin, {});

		const provider = getOptional('EMAIL_PROVIDER');
		const isProviderReady = await ctx.runQuery(
			internal.lib.sendProviders.capability.environmentSendProviderReady,
			{}
		);
		let facts: DeliveryTestFacts = {
			provider,
			isProviderUsable: isSendProviderKind(provider) && isProviderReady,
			to: args.to,
		};
		let step = nextDeliveryTestStep(facts);

		if (step.kind === 'checkRecipient') {
			const guard = await ctx.runQuery(
				internal.campaigns.sendQueries.getTestSendAllowedRecipients,
				{}
			);
			// checkpoint: the rate-limit token is spent before the provider call and
			// stays spent when the send fails, or the limit would not bound attempts.
			const rl = await ctx.runMutation(internal.campaigns.sendQueries.checkTestSendRateLimit, {
				userId: guard.callerUserId,
			});
			facts = { ...facts, recipient: { isRateLimited: !rl.ok, allowed: guard.allowed } };
			step = nextDeliveryTestStep(facts);
		}

		if (step.kind === 'resolveSender') {
			try {
				const team = await ctx.runQuery(internal.contacts.confirmationEmailQueries.getTeamInfo, {});
				facts = {
					...facts,
					sender: {
						kind: 'loaded',
						defaultFromEmail: team?.defaultFromEmail ?? null,
						defaultFromName: team?.defaultFromName ?? null,
						defaultFromDomain: getOptional('DEFAULT_FROM_DOMAIN'),
					},
				};
			} catch {
				facts = { ...facts, sender: { kind: 'unavailable' } };
			}
			step = nextDeliveryTestStep(facts);
		}

		if (step.kind === 'dispatch') {
			try {
				const sent = await ctx.runAction(
					internal.maintenance.systemMail.sendSystemEmail,
					step.message
				);
				const { provider: sentVia, providerMessageId, latencyMs, attempts } = sent;
				facts = {
					...facts,
					dispatch: {
						kind: 'accepted',
						receipt: { provider: sentVia, providerMessageId, latencyMs, attempts },
					},
				};
			} catch {
				// Swallow the provider error detail (it can carry endpoint/credential
				// hints); the answer carries a safe, actionable message instead.
				facts = { ...facts, dispatch: { kind: 'refused' } };
			}
			step = nextDeliveryTestStep(facts);
		}

		if (step.kind === 'record') {
			try {
				await ctx.runMutation(internal.delivery.status.recordTestResult, { at: Date.now() });
				facts = { ...facts, recording: 'recorded' };
			} catch {
				facts = { ...facts, recording: 'failed' };
			}
			step = nextDeliveryTestStep(facts);
		}

		// Every step above is followed by the next, and `record` is the last.
		if (step.kind !== 'answer') throwInternal(`Delivery test stopped at ${step.kind}`);
		return step.result;
	},
});
