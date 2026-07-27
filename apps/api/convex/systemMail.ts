'use node';

import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, type ActionCtx } from './_generated/server';
import { getOptional } from './lib/env';
import {
	EmailErrorCode,
	isSendProviderKind,
	type MtaExtras,
	type SendProviderKind,
} from './lib/sendProviders';
import { sendProviderDispatch } from './lib/sendProviders/dispatch';
import { defaultSendTransportId } from './lib/sendProviders/transports';
import {
	systemMailRetryDisposition,
	type SystemMailAttemptOutcome,
	type SystemMailFailureCode,
} from './lib/systemMailOutcome';

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
const systemMailArgs = {
	to: v.string(),
	from: v.string(),
	subject: v.string(),
	html: v.string(),
	idempotencyKey: v.optional(v.string()),
};

type SystemMailArgs = {
	to: string;
	from: string;
	subject: string;
	html: string;
	idempotencyKey?: string;
};

function failedAttempt(
	provider: SendProviderKind | null,
	args: SystemMailArgs,
	errorCode: SystemMailFailureCode,
	errorMessage: string
): SystemMailAttemptOutcome {
	return {
		status: 'failed',
		provider,
		errorCode,
		errorMessage,
		retryDisposition: systemMailRetryDisposition(
			provider ?? undefined,
			args.idempotencyKey,
			errorCode
		),
	};
}

export async function attemptSystemEmail(
	ctx: ActionCtx,
	args: SystemMailArgs
): Promise<SystemMailAttemptOutcome> {
	const configuredProvider = getOptional('EMAIL_PROVIDER');
	const provider = isSendProviderKind(configuredProvider) ? configuredProvider : null;
	let providerReady: boolean;
	try {
		providerReady = await ctx.runQuery(
			internal.lib.sendProviders.capability.environmentSendProviderReady,
			{}
		);
	} catch (error) {
		return failedAttempt(
			provider,
			args,
			EmailErrorCode.SERVER_ERROR,
			error instanceof Error ? error.message : 'System mail readiness check failed'
		);
	}
	if (!provider || !providerReady) {
		return failedAttempt(
			provider,
			args,
			'CONFIGURATION',
			'No system email transport configured: set EMAIL_PROVIDER to a registered transport and configure its requirements. System/auth emails (password reset, invitations, double opt-in) require a transport.'
		);
	}

	try {
		if (provider === 'mta') {
			// Behavior-preserving MTA path — routes through the shared provider
			// dispatch just like every other kind. `mtaSendProvider` defaults
			// dkimDomain to the from-domain and generates a random messageId; ipPool
			// 'transactional' is passed explicitly, so the /send body matches the
			// previous dedicated client byte-for-byte.
			const dispatched = await sendProviderDispatch(
				ctx,
				defaultSendTransportId('mta'),
				{
					to: args.to,
					from: args.from,
					subject: args.subject,
					html: args.html,
					headers: { 'Auto-Submitted': 'auto-generated' },
				},
				{
					ipPool: 'transactional',
					organizationId: 'system',
					intakePath: 'system',
					...(args.idempotencyKey ? { messageId: args.idempotencyKey } : {}),
				} satisfies MtaExtras
			);
			if (!dispatched.result.success) {
				return failedAttempt(
					provider,
					args,
					dispatched.result.errorCode,
					dispatched.result.errorMessage
				);
			}
			return {
				status: 'accepted',
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
			defaultSendTransportId(provider),
			{
				to: args.to,
				from: args.from,
				subject: args.subject,
				html: args.html,
				headers: { 'Auto-Submitted': 'auto-generated' },
			},
			provider === 'resend' && args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}
		);
		if (!dispatched.result.success) {
			return failedAttempt(
				provider,
				args,
				dispatched.result.errorCode,
				dispatched.result.errorMessage
			);
		}
		return {
			status: 'accepted',
			provider: dispatched.providerType,
			providerMessageId: dispatched.result.id,
			latencyMs: dispatched.latencyMs,
			attempts: dispatched.attempts,
		};
	} catch (error) {
		return failedAttempt(
			provider,
			args,
			EmailErrorCode.AMBIGUOUS_TIMEOUT,
			error instanceof Error ? error.message : 'System mail action failed without a receipt'
		);
	}
}

export const trySendSystemEmail = internalAction({
	args: systemMailArgs,
	handler: attemptSystemEmail,
});

export const sendSystemEmail = internalAction({
	args: systemMailArgs,
	handler: async (ctx, args) => {
		const outcome = await attemptSystemEmail(ctx, args);
		if (outcome.status === 'failed') {
			throw new Error(
				outcome.provider
					? `System email send failed via ${outcome.provider} (${outcome.errorCode}): ${outcome.errorMessage}`
					: outcome.errorMessage
			);
		}
		return outcome;
	},
});
