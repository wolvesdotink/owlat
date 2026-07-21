'use node';

import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction } from './_generated/server';
import { getOptional } from './lib/env';
import { isSendProviderKind, type SendProviderKind } from './lib/sendProviders';
import { sendProviderDispatch } from './lib/sendProviders/dispatch';

/**
 * Single transport for every system / auth / DOI email (password reset,
 * invitation, account-deletion, double opt-in, email-change).
 *
 * Routes through the configured delivery provider so a Resend/SES deployment
 * does NOT need the built-in MTA running just to send auth mail — the
 * prerequisite that lets the MTA become an opt-in service (see the `mta`
 * docker profile). Every branch — mta, resend, ses — routes through the shared
 * `sendProviderDispatch`; the MTA path passes ipPool 'transactional' and
 * `mtaSendProvider` defaults dkimDomain to the from-domain and generates a
 * random messageId, preserving the previous /send body byte-for-byte, so the
 * default self-host is unchanged.
 *
 * Fail-closed: if no provider is configured the action throws — a deployment
 * that uses email-based auth must configure a transport. RFC 3834 §5: these are
 * machine-generated, so every path carries `Auto-Submitted: auto-generated` to
 * suppress auto-responders and break mail loops.
 *
 * Runs as a `'use node'` action — matching the other send actions
 * (`delivery/worker.ts`, `campaigns/testSend.ts`) so the SES adapter's AWS SDK
 * runs in the Node runtime it's designed for. Callers (default-runtime actions
 * and the BetterAuth hooks, all of which have an ActionCtx) reach it via
 * `ctx.runAction(internal.systemMail.sendSystemEmail, …)`.
 */
export const sendSystemEmail = internalAction({
	args: {
		to: v.string(),
		from: v.string(),
		subject: v.string(),
		html: v.string(),
	},
	handler: async (
		ctx,
		args
	): Promise<{
		// Registry-aware: a bundled plugin can contribute a send provider, so the
		// receipt carries whatever kind dispatch actually used, not a fixed union.
		provider: SendProviderKind;
		providerMessageId: string;
		latencyMs: number;
		attempts: number;
	}> => {
		const provider = getOptional('EMAIL_PROVIDER');
		const providerReady = await ctx.runQuery(
			internal.lib.sendProviders.capability.environmentSendProviderReady,
			{}
		);
		if (!isSendProviderKind(provider) || !providerReady) {
			throw new Error(
				'No system email transport configured: set EMAIL_PROVIDER to a registered transport and configure its requirements. System/auth emails (password reset, invitations, double opt-in) require a transport.'
			);
		}

		if (provider === 'mta') {
			// Behavior-preserving MTA path — routes through the shared provider
			// dispatch just like every other kind. `mtaSendProvider` defaults
			// dkimDomain to the from-domain and generates a random messageId; ipPool
			// 'transactional' is passed explicitly, so the /send body matches the
			// previous dedicated client byte-for-byte.
			const dispatched = await sendProviderDispatch(
				ctx,
				'mta',
				{
					to: args.to,
					from: args.from,
					subject: args.subject,
					html: args.html,
					headers: { 'Auto-Submitted': 'auto-generated' },
				},
				{ ipPool: 'transactional' }
			);
			if (!dispatched.result.success) {
				throw new Error(`System email send failed via mta: ${dispatched.result.errorMessage}`);
			}
			return {
				provider: dispatched.providerType,
				providerMessageId: dispatched.result.id,
				latencyMs: dispatched.latencyMs,
				attempts: dispatched.attempts,
			};
		}

		// Every non-MTA kind — built-in (resend / ses) or plugin-contributed —
		// routes through the shared provider dispatch, carrying the RFC 3834
		// anti-loop header the MTA path stamps server-side.
		const dispatched = await sendProviderDispatch(
			ctx,
			provider,
			{
				to: args.to,
				from: args.from,
				subject: args.subject,
				html: args.html,
				headers: { 'Auto-Submitted': 'auto-generated' },
			},
			{}
		);
		if (!dispatched.result.success) {
			throw new Error(
				`System email send failed via ${provider}: ${dispatched.result.errorMessage}`
			);
		}
		return {
			provider: dispatched.providerType,
			providerMessageId: dispatched.result.id,
			latencyMs: dispatched.latencyMs,
			attempts: dispatched.attempts,
		};
	},
});
