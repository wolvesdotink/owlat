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
 * can-this-instance-send status; the matching test send that proves the path
 * end to end lives in the sibling `delivery/statusActions.ts`.
 *
 * Secret hygiene: `getStatus` reports the *presence* of each required env var as
 * a boolean and the composed provider kind — never a
 * credential value. The single per-kind requirement model is shared with the
 * setup wizard / `owlat doctor` via `getSendPathRequiredEnv` (`@owlat/shared`)
 * and the backend readiness check (`isSendProviderReady`), so this page
 * cannot drift from what the send path actually needs.
 */

import { v } from 'convex/values';
import { adminQuery, authedQuery } from '../lib/authedFunctions';
import { internalMutation, type QueryCtx } from '../_generated/server';
import { getOptional, isEnvPresent } from '../lib/env';
import { isSendProviderKind } from '../lib/sendProviders/types';
import { isDeliveryConfigured, isSendProviderReady } from '../lib/sendProviders/capability';
import {
	isCoreSendProviderKind,
	sendProviderCatalogEntry,
	type SendProviderKind,
} from '../lib/sendProviders/catalog';
import { OWN_ARM_TRANSPORT_KIND } from '../lib/sendProviders/strategies/adaptive_mix';
import { outboundTransportFacts } from '../lib/outboundAlignment';
import { providerFeedbackFor } from '../providers/feedback';
import {
	deriveProviderFeedbackStatus,
	feedbackVerifierEnvVars,
	providerKindFromTransportId,
	type ProviderFeedbackStatus,
} from '../providers/feedbackStatus';

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
			mtaHealth: provider === OWN_ARM_TRANSPORT_KIND ? (settings?.mtaHealth ?? null) : null,
		};
	},
});

/**
 * Generic feedback-channel status for any default or named transport.
 *
 * Feedback credentials remain deployment-wide in this migration, so a named
 * transport intentionally reads the same verifier channel as its provider kind.
 * Only environment-variable names and presence booleans influence the result;
 * no secret or retained webhook body leaves the backend.
 */
export const getProviderFeedbackStatus = adminQuery({
	args: { transportId: v.string() },
	handler: async (ctx, { transportId }): Promise<ProviderFeedbackStatus | null> => {
		const kind = providerKindFromTransportId(transportId);
		if (!kind) return null;
		const descriptor = sendProviderCatalogEntry(kind);
		const feedback = providerFeedbackFor(kind);
		const missingVariables = feedback
			? feedbackVerifierEnvVars(feedback.verifier).filter((name) => !isEnvPresent(name))
			: [];
		return deriveProviderFeedbackStatus({
			hasFeedback: feedback !== undefined,
			ceremony: descriptor.providerFeedback?.setupPanel ?? 'none',
			missingVariables,
			lastEventAt: feedback ? await lastFeedbackEventAt(ctx, kind) : null,
			now: Date.now(),
		});
	},
});

/**
 * When this transport's feedback channel last delivered, by tier.
 *
 * CORE KINDS read the raw-retention table, which they populate by default.
 *
 * PLUGIN KINDS CANNOT: raw retention is opt-in per adapter (`storeRawPayload`,
 * default off), so grading a plugin channel by `webhookPayloads` reported a
 * perfectly working non-retaining transport as `awaiting_event` forever. They
 * read the durable marker the feedback route stamps on every completed batch
 * instead. The replay-claim rows are NOT that signal: they expire inside the
 * signature tolerance window (fifteen minutes at most) while this grading works
 * over seven days.
 */
async function lastFeedbackEventAt(ctx: QueryCtx, kind: SendProviderKind): Promise<number | null> {
	if (!isCoreSendProviderKind(kind)) {
		const activity = await ctx.db
			.query('pluginWebhookFeedbackActivity')
			.withIndex('by_transport_kind', (q) => q.eq('transportKind', kind))
			.first();
		return activity?.lastEventAt ?? null;
	}
	const latest = await ctx.db
		.query('webhookPayloads')
		.withIndex('by_source_and_received_at', (q) => q.eq('source', kind))
		.order('desc')
		.first();
	return latest?.receivedAt ?? null;
}

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
		const settings = await ctx.db.query('instanceSettings').first(); // bounded: singleton row

		return {
			provider,
			providerLabel: isSendProviderKind(provider) ? sendProviderCatalogEntry(provider).label : null,
			canSend,
			advancedRoutingActive,
			health,
			infrastructure: provider === OWN_ARM_TRANSPORT_KIND ? (settings?.mtaHealth ?? null) : null,
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
 * Internal: only `statusActions.sendTest` (after a real send succeeds) writes
 * this.
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
