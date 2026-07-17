import { PLUGIN_IMPORT_PROVIDER_CAPABILITY } from '@owlat/plugin-kit';
import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import {
	authorizeHostedContribution,
	recordHostedContributionOutcome,
	type HostedContributionAuthorizationSpec,
} from './hostedContributionAuthorization';
import { pluginImportProviderDefinition } from './importProviderCatalog';

/**
 * Runtime authorization seam for plugin-contributed import providers. The
 * import walker resolves a plugin provider kind through the host and calls
 * `authorizeStart` before opening a run; the provider's paged fetch runs only
 * while flag, grant, env and singleton scope hold.
 */
const SPEC: HostedContributionAuthorizationSpec = {
	capability: PLUGIN_IMPORT_PROVIDER_CAPABILITY,
	operation: 'import.provider',
	failureReasonCode: 'import_provider_failed',
	attributionErrorMessage: 'Invalid bundled import provider attribution',
	definitionFor: pluginImportProviderDefinition,
};

/** Rechecks registration, flag, grant, env, and singleton scope before a run. */
export const authorizeStart = internalMutation({
	args: { pluginId: v.string(), providerKind: v.string() },
	handler: (ctx, args): Promise<boolean> =>
		authorizeHostedContribution(ctx, SPEC, args.pluginId, args.providerKind),
});

export const recordOutcome = internalMutation({
	args: {
		pluginId: v.string(),
		providerKind: v.string(),
		outcome: v.union(v.literal('completed'), v.literal('failed')),
	},
	handler: (ctx, args): Promise<void> =>
		recordHostedContributionOutcome(ctx, SPEC, args.pluginId, args.providerKind, args.outcome),
});
