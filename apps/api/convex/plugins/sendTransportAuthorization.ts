import { PLUGIN_SEND_TRANSPORT_CAPABILITY, type PluginId } from '@owlat/plugin-kit';
import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { sendProviderCatalogEntry, isSendProviderKind } from '../lib/sendProviders/catalog';
import {
	authorizeHostedContribution,
	recordHostedContributionOutcome,
	type HostedContributionAuthorizationSpec,
} from './hostedContributionAuthorization';

/**
 * Runtime authorization seam for plugin-contributed send transports.
 *
 * The send catalog is the one that also holds CORE kinds, so `definitionFor`
 * narrows to plugin entries: a core kind has no `pluginId` and is not a plugin
 * contribution to authorize. Attempt counts ride the shared path as audit
 * extras, so this seam adds a field rather than a second copy of the sequence.
 */
const SPEC: HostedContributionAuthorizationSpec = {
	capability: PLUGIN_SEND_TRANSPORT_CAPABILITY,
	operation: 'transport.send',
	failureReasonCode: 'provider_dispatch_failed',
	attributionErrorMessage: 'Invalid bundled send transport attribution',
	definitionFor: (kind: string): { readonly pluginId: PluginId } | undefined => {
		if (!isSendProviderKind(kind)) return undefined;
		const entry = sendProviderCatalogEntry(kind);
		return entry.pluginId ? { pluginId: entry.pluginId } : undefined;
	},
};

/** Rechecks flag, grant, environment, and singleton scope just before an attempt. */
export const authorizeAttempt = internalMutation({
	args: { pluginId: v.string(), providerKind: v.string(), priorAttempts: v.number() },
	handler: async (ctx, args): Promise<boolean> => {
		if (!Number.isSafeInteger(args.priorAttempts) || args.priorAttempts < 0) return false;
		return authorizeHostedContribution(ctx, SPEC, args.pluginId, args.providerKind, {
			attempts: args.priorAttempts,
		});
	},
});

/** Persists only attribution, outcome, and attempt count after terminal dispatch. */
export const recordOutcome = internalMutation({
	args: {
		pluginId: v.string(),
		providerKind: v.string(),
		attempts: v.number(),
		outcome: v.union(v.literal('completed'), v.literal('failed')),
	},
	handler: (ctx, args): Promise<void> =>
		recordHostedContributionOutcome(
			ctx,
			SPEC,
			args.pluginId,
			args.providerKind,
			args.outcome,
			undefined,
			{ attempts: args.attempts }
		),
});
