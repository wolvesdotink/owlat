/**
 * Delivery-provider status surface — the admin-facing answer to "can this
 * instance actually send email, and if not, what's missing?".
 *
 * Today the only pre-send signal a self-host operator gets is domain
 * verification, which says nothing about whether a delivery PROVIDER
 * (`EMAIL_PROVIDER` + its credentials) is configured. A user can verify a
 * domain, complete every onboarding step, and still have no transport — every
 * recipient would march straight to `failed`. This module exposes the send-path
 * configuration so the Settings → Delivery page can show a red/green
 * can-this-instance-send status and let an admin fire a real test email.
 *
 * Secret hygiene: `getStatus` reports the *presence* of each required env var as
 * a boolean and the provider KIND name (`mta` / `resend` / `ses`) — never a
 * credential value. The single per-kind requirement model is shared with the
 * setup wizard / `owlat doctor` via `getSendPathRequiredEnv` (`@owlat/shared`)
 * and the backend capability check (`providerKindConfigured`), so this page
 * cannot drift from what the send path actually needs.
 */

import { v } from 'convex/values';
import { getSendPathRequiredEnv, isDeliveryProviderKind } from '@owlat/shared';
import { adminQuery, authedAction } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { internalMutation } from '../_generated/server';
import { getOptional, type EnvKey } from '../lib/env';
import { isSendProviderKind } from '../lib/sendProviders';
import { providerKindConfigured, isDeliveryConfigured } from '../lib/sendProviders/capability';

/**
 * Report the delivery send-path configuration as booleans for the admin
 * Settings → Delivery page. Admin-gated (`adminQuery` → `organization:manage`):
 * the env-presence map is operational config, not a member-level read.
 *
 * Returns only:
 *  - `provider`            the `EMAIL_PROVIDER` kind name (or null) — not a secret
 *  - `isKnownProvider`     whether that names a real adapter (mta/resend/ses)
 *  - `requiredEnv`         per required var: `{ name, isPresent }` (boolean only)
 *  - `providerConfigured`  provider known AND all its credentials present (env)
 *  - `canSend`             the real gate the send path uses (`isDeliveryConfigured`
 *                          — providerRoutes row wins, else env)
 *  - `lastTestSucceededAt` timestamp of the last successful test send (or null)
 *
 * No credential VALUE is ever returned.
 */
export const getStatus = adminQuery({
	args: {},
	handler: async (ctx) => {
		const provider = getOptional('EMAIL_PROVIDER') ?? null;
		const isKnownProvider = isDeliveryProviderKind(provider ?? undefined);

		// Presence-only: the required env var NAMES are public (they're documented
		// in the setup wizard); their VALUES never leave the backend.
		const requiredEnv = getSendPathRequiredEnv(provider ?? undefined).map((name) => ({
			name,
			isPresent: Boolean(getOptional(name as EnvKey)),
		}));

		const providerConfigured = isSendProviderKind(provider) && providerKindConfigured(provider);
		const canSend = await isDeliveryConfigured(ctx);

		const settings = await ctx.db.query('instanceSettings').first(); // bounded: singleton row
		return {
			provider,
			isKnownProvider,
			requiredEnv,
			providerConfigured,
			canSend,
			lastTestSucceededAt: settings?.deliveryTestLastSucceededAt ?? null,
		};
	},
});

/**
 * Record a successful delivery test on the singleton instanceSettings row.
 * Internal: only `sendTest` (after a real send succeeds) writes this.
 */
export const recordTestResult = internalMutation({
	args: { at: v.number() },
	handler: async (ctx, args): Promise<null> => {
		const settings = await ctx.db.query('instanceSettings').first(); // bounded: singleton row
		if (settings) {
			await ctx.db.patch(settings._id, {
				deliveryTestLastSucceededAt: args.at,
				updatedAt: args.at,
			});
		} else {
			await ctx.db.insert('instanceSettings', {
				deliveryTestLastSucceededAt: args.at,
				createdAt: args.at,
				updatedAt: args.at,
			});
		}
		return null;
	},
});

/**
 * Send a real test email through the configured delivery provider, so an admin
 * can confirm the send path works end-to-end before trusting it with a campaign
 * or transactional traffic. Reuses the single system transport
 * (`internal.systemMail.sendSystemEmail`) — it routes through whatever provider
 * `EMAIL_PROVIDER` names (MTA / Resend / SES); this does NOT add a parallel
 * sender. Records a success timestamp the status page and onboarding surface.
 *
 * Returns `{ success, error }` rather than throwing on a provider failure: a
 * misconfigured transport is the expected case this button exists to diagnose,
 * so the UI shows the reason inline instead of a generic toast.
 */
// authz: admin floor enforced via internal.auth.membership.assertOrgAdmin
// (organization:manage) inside the handler — actions can't call
// requireOrgPermission directly.
export const sendTest = authedAction({
	args: { to: v.string() },
	handler: async (ctx, args): Promise<{ success: boolean; error: string | null }> => {
		// Admin floor (organization:manage) — actions can't run requireOrgPermission
		// directly, so assert through the internal query that inherits our identity.
		await ctx.runQuery(internal.auth.membership.assertOrgAdmin, {});

		const provider = getOptional('EMAIL_PROVIDER');
		if (!isSendProviderKind(provider) || !providerKindConfigured(provider)) {
			return {
				success: false,
				error:
					'No delivery provider is configured. Set EMAIL_PROVIDER (mta, resend, or ses) and its credentials, then try again.',
			};
		}

		const to = args.to.trim();
		if (!to) {
			return { success: false, error: 'Enter a recipient address for the test email.' };
		}

		const team = await ctx.runQuery(internal.confirmationEmailQueries.getTeamInfo, {});
		const fromEmail =
			team?.defaultFromEmail || `noreply@${getOptional('DEFAULT_FROM_DOMAIN') || 'mail.owlat.app'}`;
		const fromName = team?.defaultFromName || 'Owlat';
		const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;

		try {
			await ctx.runAction(internal.systemMail.sendSystemEmail, {
				to,
				from,
				subject: 'Owlat delivery test',
				html:
					'<p>This is a test email from your Owlat instance.</p>' +
					`<p>If you received it, your delivery provider (<strong>${provider}</strong>) is working.</p>`,
			});
		} catch {
			// Swallow the provider error detail (it can carry endpoint/credential
			// hints) and surface a safe, actionable message instead.
			return {
				success: false,
				error: 'Test send failed. Check your provider credentials and the deployment logs.',
			};
		}

		await ctx.runMutation(internal.delivery.status.recordTestResult, { at: Date.now() });
		return { success: true, error: null };
	},
});
