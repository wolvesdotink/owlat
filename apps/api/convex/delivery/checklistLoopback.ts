'use node';

import { createHash } from 'node:crypto';
import {
	createDeliverabilityProbeToken,
	verifyDeliverabilityProbeToken,
} from '@owlat/shared/deliverabilityProbeToken';
import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { authedAction } from '../lib/authedFunctions';
import { throwInvalidState } from '../_utils/errors';
import { getOptional } from '../lib/env';
import { OWN_ARM_TRANSPORT_KIND } from '../lib/sendProviders/strategies/adaptive_mix';
import { internalAction } from '../_generated/server';
import { authResultValidator } from '../lib/literalValidators';

const PROBE_TIMEOUT_MS = 15 * 60_000;

type LoopbackStatus = 'sending' | 'awaiting_inbound' | 'passed' | 'failed' | 'timed_out';
type LoopbackStartResult = { status: LoopbackStatus | 'missing' };
type LoopbackInboundResult = {
	recorded: boolean;
	status?: 'passed' | 'failed';
};
type LoopbackStartContext =
	| { allowed: true; domain: string }
	| { allowed: false; reason: string; missing?: string[] };

function tokenHash(token: string): string {
	return createHash('sha256').update(token, 'utf8').digest('hex');
}

// authz: owner/admin gate is enforced by the inherited-identity
// `checklist.getAdminScope` query before any probe state is created or email sent.
export const start = authedAction({
	args: { domainId: v.id('domains') },
	handler: async (ctx, args): Promise<LoopbackStartResult> => {
		const { organizationId } = (await ctx.runQuery(
			internal.delivery.checklist.getAdminScope,
			{}
		)) as { organizationId: string };
		const startContext = (await ctx.runQuery(
			internal.delivery.checklistLoopbackState.getStartContext,
			{ organizationId, domainId: args.domainId }
		)) as LoopbackStartContext;
		if (!startContext.allowed) {
			throwInvalidState('Complete the blocking deliverability checks before running a proof.');
		}
		if (getOptional('EMAIL_PROVIDER') !== OWN_ARM_TRANSPORT_KIND) {
			throwInvalidState(
				'The end-to-end proof requires the built-in MTA as the active delivery provider.'
			);
		}
		const returnPathDomain = getOptional('MTA_RETURN_PATH_DOMAIN');
		const webhookSecret = getOptional('MTA_WEBHOOK_SECRET');
		if (!returnPathDomain || !webhookSecret) {
			throwInvalidState('The end-to-end proof requires the global MTA return-path domain.');
		}
		const attemptId = crypto.randomUUID();
		const now = Date.now();
		const expiresAt = now + PROBE_TIMEOUT_MS;
		const token = createDeliverabilityProbeToken(webhookSecret, expiresAt);
		const recipient = `deliverability-probe+${token}@${returnPathDomain}`;
		// checkpoint: the attempt is claimed before the irreversible probe send; create
		// schedules expire at expiresAt, which times out an attempt a crash leaves in
		// sending, and a second start meanwhile reports this attempt instead of sending.
		const created = (await ctx.runMutation(internal.delivery.checklistLoopbackState.create, {
			organizationId,
			attemptId,
			domainId: args.domainId,
			domain: startContext.domain,
			correlationTokenHash: tokenHash(token),
			startedAt: now,
			expiresAt,
		})) as { created: boolean; status: LoopbackStatus };
		if (!created.created) return { status: created.status };
		let providerMessageId: string | null;
		try {
			const accepted = (await ctx.runAction(internal.maintenance.systemMail.sendSystemEmail, {
				to: recipient,
				from: `Owlat deliverability probe <deliverability-probe@${startContext.domain}>`,
				subject: 'Owlat end-to-end deliverability probe',
				html:
					'<p>This is an automated Owlat end-to-end deliverability probe.</p>' +
					'<p>The configured probe receiver should return the correlation token with observed SPF, DKIM, DMARC, TLS, sending-IP, and PTR evidence.</p>',
			})) as { providerMessageId: string };
			providerMessageId = accepted.providerMessageId;
		} catch {
			providerMessageId = null;
		}
		// The one commit: settle the attempt with what the provider answered. Both
		// leave an attempt that inbound evidence or expiry already moved alone.
		if (providerMessageId === null) {
			const status = (await ctx.runMutation(
				internal.delivery.checklistLoopbackState.markSendFailed,
				{
					organizationId,
					attemptId,
					detail: 'The configured outbound provider did not accept the probe.',
					now: Date.now(),
				}
			)) as LoopbackStatus | 'missing';
			return { status };
		}
		const status = (await ctx.runMutation(internal.delivery.checklistLoopbackState.markAccepted, {
			organizationId,
			attemptId,
			providerMessageId,
		})) as LoopbackStatus | 'missing';
		return { status };
	},
});

/**
 * Trusted receiver seam. The MTA/probe adapter calls this internal action with
 * the raw token extracted from the recipient/subject and its real auth trace.
 */
export const recordInbound = internalAction({
	args: {
		token: v.string(),
		spf: authResultValidator,
		dkim: authResultValidator,
		dmarc: authResultValidator,
		dkimSelector: v.optional(v.string()),
		tlsVersion: v.string(),
		sendingIp: v.string(),
		ptr: v.string(),
		detail: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<LoopbackInboundResult> => {
		const { token, ...evidence } = args;
		const secret = getOptional('MTA_WEBHOOK_SECRET');
		if (!secret || !verifyDeliverabilityProbeToken(token, secret)) {
			return { recorded: false as const };
		}
		return (await ctx.runMutation(internal.delivery.checklistLoopbackState.recordInboundEvidence, {
			...evidence,
			correlationTokenHash: tokenHash(token),
			now: Date.now(),
		})) as LoopbackInboundResult;
	},
});
