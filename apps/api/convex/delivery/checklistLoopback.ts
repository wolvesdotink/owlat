'use node';

import { createHash } from 'node:crypto';
import {
	createDeliverabilityProbeToken,
	verifyDeliverabilityProbeToken,
} from '@owlat/shared/deliverabilityProbeToken';
import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { authedAction } from '../lib/authedFunctions';
import { getOptional } from '../lib/env';
import { internalAction } from '../_generated/server';

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
			throw new Error('Complete the blocking deliverability checks before running a proof.');
		}
		if (getOptional('EMAIL_PROVIDER') !== 'mta') {
			throw new Error(
				'The end-to-end proof requires the built-in MTA as the active delivery provider.'
			);
		}
		const returnPathDomain = getOptional('MTA_RETURN_PATH_DOMAIN');
		const webhookSecret = getOptional('MTA_WEBHOOK_SECRET');
		if (!returnPathDomain || !webhookSecret) {
			throw new Error('The end-to-end proof requires the global MTA return-path domain.');
		}
		const attemptId = crypto.randomUUID();
		const now = Date.now();
		const expiresAt = now + PROBE_TIMEOUT_MS;
		const token = createDeliverabilityProbeToken(webhookSecret, expiresAt);
		const recipient = `deliverability-probe+${token}@${returnPathDomain}`;
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
		try {
			const accepted = (await ctx.runAction(internal.systemMail.sendSystemEmail, {
				to: recipient,
				from: `Owlat deliverability probe <deliverability-probe@${startContext.domain}>`,
				subject: 'Owlat end-to-end deliverability probe',
				html:
					'<p>This is an automated Owlat end-to-end deliverability probe.</p>' +
					'<p>The configured probe receiver should return the correlation token with observed SPF, DKIM, DMARC, TLS, sending-IP, and PTR evidence.</p>',
			})) as { providerMessageId: string };
			const status = (await ctx.runMutation(internal.delivery.checklistLoopbackState.markAccepted, {
				organizationId,
				attemptId,
				providerMessageId: accepted.providerMessageId,
			})) as LoopbackStatus | 'missing';
			return { status };
		} catch {
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
	},
});

/**
 * Trusted receiver seam. The MTA/probe adapter calls this internal action with
 * the raw token extracted from the recipient/subject and its real auth trace.
 */
export const recordInbound = internalAction({
	args: {
		token: v.string(),
		spf: v.union(v.literal('pass'), v.literal('fail'), v.literal('unknown')),
		dkim: v.union(v.literal('pass'), v.literal('fail'), v.literal('unknown')),
		dmarc: v.union(v.literal('pass'), v.literal('fail'), v.literal('unknown')),
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
