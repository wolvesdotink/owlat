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
 * a boolean and the composed provider kind — never a
 * credential value. The single per-kind requirement model is shared with the
 * setup wizard / `owlat doctor` via `getSendPathRequiredEnv` (`@owlat/shared`)
 * and the backend readiness check (`isSendProviderReady`), so this page
 * cannot drift from what the send path actually needs.
 */

import { v } from 'convex/values';
import { adminQuery, authedAction, authedQuery } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { internalMutation } from '../_generated/server';
import { getOptional, isEnvPresent } from '../lib/env';
import { isSendProviderKind } from '../lib/sendProviders/types';
import { isDeliveryConfigured, isSendProviderReady } from '../lib/sendProviders/capability';
import { sendProviderCatalogEntry } from '../lib/sendProviders/catalog';
import { outboundTransportFacts } from '../lib/outboundAlignment';

/**
 * Report the delivery send-path configuration as booleans for the admin
 * Settings → Delivery page. Admin-gated (`adminQuery` → `organization:manage`):
 * the env-presence map is operational config, not a member-level read.
 *
 * Returns only:
 *  - `provider`            the `EMAIL_PROVIDER` kind name (or null) — not a secret
 *  - `isKnownProvider`     whether that names a composed transport
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
		const isKnownProvider = isSendProviderKind(provider);
		const providerEntry = isKnownProvider ? sendProviderCatalogEntry(provider) : null;

		// Presence-only: the required env var NAMES are public (they're documented
		// in the setup wizard); their VALUES never leave the backend.
		const requiredEnv = (providerEntry?.requiredEnvVars ?? []).map((name) => ({
			name,
			isPresent: isEnvPresent(name),
		}));

		const providerConfigured = isKnownProvider && (await isSendProviderReady(ctx, provider));
		const canSend = await isDeliveryConfigured(ctx);

		const settings = await ctx.db.query('instanceSettings').first(); // bounded: singleton row
		return {
			provider,
			providerLabel: providerEntry?.label ?? null,
			isKnownProvider,
			requiredEnv,
			providerConfigured,
			canSend,
			// Non-secret: the active outbound TLS floor for the built-in MTA, so the
			// transport editor can seed its selector and a re-apply never silently
			// resets a previously-chosen floor to `opportunistic`. Unset ⇒ null.
			outboundTlsMode: getOptional('OUTBOUND_TLS_MODE') ?? null,
			lastTestSucceededAt: settings?.deliveryTestLastSucceededAt ?? null,
		};
	},
});

/**
 * Timestamp (ms) of the most recent SNS message received on `/webhooks/ses`, or
 * null if none. Powers the Delivery page's live "last event received" line so an
 * admin can confirm the SES → SNS feedback loop is actually delivering to this
 * instance. Reads only the audit-store's newest `ses` row via the
 * `by_source_and_received_at` index — never the payload body, so nothing
 * sensitive leaves the backend. Admin-gated (operational config).
 */
export const getLastSesEventAt = adminQuery({
	args: {},
	handler: async (ctx): Promise<number | null> => {
		const latest = await ctx.db
			.query('webhookPayloads')
			.withIndex('by_source_and_received_at', (q) => q.eq('source', 'ses'))
			.order('desc')
			.first();
		return latest?.receivedAt ?? null;
	},
});

/**
 * Non-secret transport summary for the Delivery hub's single transport card and
 * the per-transport DNS guidance on the domains page. Member-readable
 * (`authedQuery`): it exposes only which transport kind is active, whether the
 * instance can send, whether advanced provider-routing is in use, and the active
 * provider's rolling health — never a credential value or env-var presence map
 * (those stay behind the admin-gated `getStatus`). Editing the transport is
 * still admin-only (the config page it links to enforces the floor), so members
 * can see the state without being able to change it.
 *
 * `health` mirrors the active provider's `providerHealth` row (or null before
 * the first send) — only the fields the card renders (`status` + when it was
 * last checked). `advancedRoutingActive` is true when a `providerRoutes` row has
 * at least one enabled provider — the signal that the instance-level transport
 * is being overridden by the advanced escape hatch.
 */
// all-members: non-secret transport state (kind, canSend, routing flag, rolling
// health); credentials/env-presence stay behind admin-gated getStatus.
export const getTransportSummary = authedQuery({
	args: {},
	handler: async (ctx) => {
		const provider = getOptional('EMAIL_PROVIDER') ?? null;
		const canSend = await isDeliveryConfigured(ctx);

		// Advanced routing is "active" when any configured route enables a provider.
		const routes = await ctx.db.query('providerRoutes').collect(); // bounded: one row per message type
		let advancedRoutingActive = false;
		for (const route of routes) {
			for (const routeProvider of route.providers) {
				if (
					routeProvider.isEnabled &&
					isSendProviderKind(routeProvider.providerType) &&
					(await isSendProviderReady(ctx, routeProvider.providerType))
				) {
					advancedRoutingActive = true;
					break;
				}
			}
			if (advancedRoutingActive) break;
		}

		// Rolling health for the active provider kind (null before the first send).
		// Only the two fields the transport card renders — status + last-checked.
		let health: {
			status: 'healthy' | 'degraded' | 'down';
			lastCheckedAt: number;
		} | null = null;
		if (isSendProviderKind(provider)) {
			const record = await ctx.db
				.query('providerHealth')
				.withIndex('by_provider_type', (q) => q.eq('providerType', provider))
				.first();
			if (record) {
				health = {
					status: record.status,
					lastCheckedAt: record.lastCheckedAt,
				};
			}
		}

		// Non-secret outbound identities powering the readiness panel's
		// sender-alignment gate: the transport's normalized kind plus the effective
		// DKIM `d=` / return-path domains (DNS-facing values, never credentials).
		const facts = outboundTransportFacts();

		return {
			provider,
			providerLabel: isSendProviderKind(provider) ? sendProviderCatalogEntry(provider).label : null,
			canSend,
			advancedRoutingActive,
			health,
			alignment: {
				kind: facts.kind,
				returnPathDomain: facts.returnPathDomain,
				dkimDomain: facts.dkimDomain,
			},
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
		const providerReady = await ctx.runQuery(
			internal.lib.sendProviders.capability.environmentSendProviderReady,
			{}
		);
		if (!isSendProviderKind(provider) || !providerReady) {
			return {
				success: false,
				error:
					'No delivery provider is configured. Set EMAIL_PROVIDER to a registered transport and configure its requirements, then try again.',
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
