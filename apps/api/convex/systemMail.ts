'use node';

import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, type ActionCtx } from './_generated/server';
import { getOptional } from './lib/env';
import {
	EmailErrorCode,
	buildSystemMailExtrasFor,
	isSendProviderKind,
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
 * docker profile). EVERY kind takes one path through the shared
 * `sendProviderDispatch`, and this module names none of them: the per-send knobs
 * come from `buildSystemMailExtras` on the provider module (the seams plan's
 * P0.4, folding this file's `provider === 'mta'` arm and `provider === 'resend'`
 * ternary into the same contract P0.1 gave the governed boundary). The MTA's
 * adapter still supplies ipPool 'transactional' plus the system intake scope and
 * still defaults dkimDomain to the from-domain and mints a random messageId, so
 * the /send/system body is byte-for-byte what it was and the default self-host is
 * unchanged.
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
		// ONE dispatch for every kind — built-in (mta / ses / resend / smtp /
		// mandrill) or plugin-contributed — carrying the RFC 3834 anti-loop header
		// and whatever per-send knobs the PROVIDER asks for.
		//
		// There used to be two arms here: an `if (provider === 'mta')` copy of this
		// whole call whose only difference was an inline MTA payload, and a
		// `provider === 'resend' && key` ternary for the dedup header. Same shape
		// the governed boundary shed in P0.1, one file over — and the same cost, a
		// send path every new kind had to edit to be allowed any knob at all. The
		// facts go in, the module decides what to make of them.
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
			buildSystemMailExtrasFor(provider, { idempotencyKey: args.idempotencyKey })
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
