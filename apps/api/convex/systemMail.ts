'use node';

import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { getOptional } from './lib/env';
import { isSendProviderKind } from './lib/sendProviders';
import { sendProviderDispatch } from './lib/sendProviders/dispatch';
import { providerKindConfigured } from './lib/sendProviders/capability';
import { sendViaInstanceMta } from './lib/instanceMailer';

/**
 * Single transport for every system / auth / DOI email (password reset,
 * invitation, account-deletion, double opt-in, email-change).
 *
 * Routes through the configured delivery provider so a Resend/SES deployment
 * does NOT need the built-in MTA running just to send auth mail — the
 * prerequisite that lets the MTA become an opt-in service (see the `mta`
 * docker profile). The MTA branch is byte-for-byte the previous behavior
 * (`sendViaInstanceMta`, preserving ipPool 'transactional', dkimDomain, and the
 * Auto-Submitted header), so the default self-host is unchanged; `resend`/`ses`
 * are new paths.
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
	handler: async (ctx, args): Promise<void> => {
		const provider = getOptional('EMAIL_PROVIDER');
		if (!isSendProviderKind(provider) || !providerKindConfigured(provider)) {
			throw new Error(
				'No system email transport configured: set EMAIL_PROVIDER (mta, resend, or ses) and its credentials. System/auth emails (password reset, invitations, double opt-in) require a transport.',
			);
		}

		if (provider === 'mta') {
			// Unchanged MTA path — preserves ipPool 'transactional', dkimDomain,
			// and the Auto-Submitted header exactly as before.
			await sendViaInstanceMta(args);
			return;
		}

		// resend / ses: route through the provider abstraction, carrying the
		// RFC 3834 anti-loop header the MTA path stamps server-side.
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
			{},
		);
		if (!dispatched.result.success) {
			throw new Error(
				`System email send failed via ${provider}: ${dispatched.result.errorMessage}`,
			);
		}
	},
});
