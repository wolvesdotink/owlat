/**
 * Compatibility surface in `@owlat/shared`. Shared owns the *types*, the static
 * *client metadata* baseline and the email-client registry it seeds. Per-block
 * Feature compatibility and Property compatibility live in Block modules inside
 * `@owlat/email-renderer`; scoring and builder-UI helpers live next to them.
 */

// Types
export type {
	SupportLevel,
	RenderEngine,
	DegradationImpact,
	EmailClientInfo,
	ClientSupport,
	CompatibilityFix,
	FeatureCompatibility,
	PropertyCompatibility,
	BlockCompatibilityScore,
} from './types';

// Client metadata
export { emailClients, fullSupport } from './clients';

// Client registry and the tolerant support lookup.
export { emailClientRegistry, lookupClientSupport } from './registry';
