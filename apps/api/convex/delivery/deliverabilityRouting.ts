import { v } from 'convex/values';
import { extractDomainOrNull } from '@owlat/shared';
import { DESTINATION_PROVIDER_KEYS } from '@owlat/shared/deliverabilityRouting';
import { internalMutation } from '../_generated/server';

export const DELIVERABILITY_SIGNAL_MAX_AGE_MS = 10 * 60 * 1000;
export const DELIVERABILITY_MIN_HEALTHY_MS = 15 * 60 * 1000;
export const DELIVERABILITY_FALLBACK_COOLDOWN_MS = 30 * 60 * 1000;
const STATE_RETENTION_MS = 24 * 60 * 60 * 1000;
const DOMAIN_CLASSIFICATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PROVIDERS = ['all', ...DESTINATION_PROVIDER_KEYS] as const;

const providerValidator = v.union(
	v.literal('all'),
	v.literal('gmail'),
	v.literal('microsoft'),
	v.literal('yahoo'),
	v.literal('apple'),
	v.literal('other')
);

const destinationProviderValidator = v.union(
	v.literal('gmail'),
	v.literal('microsoft'),
	v.literal('yahoo'),
	v.literal('apple'),
	v.literal('other')
);

const sourceValidator = v.union(
	v.literal('ip_quarantined'),
	v.literal('dnsbl_listed'),
	v.literal('breaker_open'),
	v.literal('persistent_defers')
);

const signalValidator = v.object({
	provider: providerValidator,
	source: sourceValidator,
	severity: v.union(v.literal('warning'), v.literal('critical')),
	observedAt: v.number(),
});

/**
 * Apply one complete MTA snapshot. Convex serializes this mutation, making the
 * per-provider hysteresis transition OCC-safe and idempotent by snapshot time.
 */
export const applySnapshot = internalMutation({
	args: {
		organizationId: v.string(),
		generatedAt: v.number(),
		signals: v.array(signalValidator),
		appliedAt: v.number(),
	},
	handler: async (ctx, args) => {
		for (const provider of PROVIDERS) {
			const existing = await ctx.db
				.query('deliverabilityRouteStates')
				.withIndex('by_org_provider', (q) =>
					q.eq('organizationId', args.organizationId).eq('destinationProvider', provider)
				)
				.first();
			if (existing && existing.snapshotGeneratedAt >= args.generatedAt) continue;

			const signals = args.signals
				.filter((signal) => signal.provider === provider)
				.map(({ source, severity, observedAt }) => ({ source, severity, observedAt }));
			const degraded = signals.length > 0;
			let persistedSignals = signals;
			let isFallbackActive = existing?.isFallbackActive ?? false;
			let fallbackActiveSince = existing?.fallbackActiveSince;
			let healthySince = existing?.healthySince;
			if (degraded) {
				isFallbackActive = true;
				fallbackActiveSince ??= args.appliedAt;
				healthySince = undefined;
			} else if (isFallbackActive) {
				// Preserve the triggering reasons while hysteresis deliberately keeps
				// fallback active. Route resolution uses these reasons as its decision
				// input, so clearing them before failback would bypass the cooldown.
				persistedSignals = existing?.signals ?? [];
				healthySince ??= args.appliedAt;
				const healthyLongEnough = args.appliedAt - healthySince >= DELIVERABILITY_MIN_HEALTHY_MS;
				const cooldownComplete =
					fallbackActiveSince !== undefined &&
					args.appliedAt - fallbackActiveSince >= DELIVERABILITY_FALLBACK_COOLDOWN_MS;
				if (healthyLongEnough && cooldownComplete) {
					isFallbackActive = false;
					persistedSignals = [];
					fallbackActiveSince = undefined;
					healthySince = undefined;
				}
			} else {
				healthySince = undefined;
				fallbackActiveSince = undefined;
			}

			const fields = {
				organizationId: args.organizationId,
				destinationProvider: provider,
				isFallbackActive,
				signals: persistedSignals,
				fallbackActiveSince,
				healthySince,
				snapshotGeneratedAt: args.generatedAt,
				expiresAt: args.appliedAt + STATE_RETENTION_MS,
				updatedAt: args.appliedAt,
			};
			if (existing) await ctx.db.patch(existing._id, fields);
			else await ctx.db.insert('deliverabilityRouteStates', fields);
		}
	},
});

/**
 * Cache the MTA's MX-derived provider identity after a successful delivery.
 * Retries are idempotent by observation time, and the short retention means a
 * recipient domain's mail-hosting migration self-corrects without a backfill.
 */
export const recordDestinationProviderDomain = internalMutation({
	args: {
		organizationId: v.string(),
		recipient: v.string(),
		destinationProvider: destinationProviderValidator,
		observedAt: v.number(),
	},
	handler: async (ctx, args) => {
		if (!args.organizationId || args.organizationId.length > 128) return { recorded: false };
		const domain = extractDomainOrNull(args.recipient);
		if (!domain) return { recorded: false };
		const existing = await ctx.db
			.query('destinationProviderDomains')
			.withIndex('by_org_domain', (q) =>
				q.eq('organizationId', args.organizationId).eq('domain', domain)
			)
			.first();
		if (existing && existing.observedAt >= args.observedAt) return { recorded: false };
		const fields = {
			organizationId: args.organizationId,
			domain,
			destinationProvider: args.destinationProvider,
			observedAt: args.observedAt,
			expiresAt: args.observedAt + DOMAIN_CLASSIFICATION_RETENTION_MS,
		};
		if (existing) await ctx.db.patch(existing._id, fields);
		else await ctx.db.insert('destinationProviderDomains', fields);
		return { recorded: true };
	},
});

export const cleanupExpired = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const expired = await ctx.db
			.query('deliverabilityRouteStates')
			.withIndex('by_expires_at', (q) => q.lt('expiresAt', now))
			.take(32);
		for (const row of expired) await ctx.db.delete(row._id);
		const remaining = 32 - expired.length;
		const expiredDomains = remaining
			? await ctx.db
					.query('destinationProviderDomains')
					.withIndex('by_expires_at', (q) => q.lt('expiresAt', now))
					.take(remaining)
			: [];
		for (const row of expiredDomains) await ctx.db.delete(row._id);
		return { deleted: expired.length + expiredDomains.length };
	},
});
