/**
 * Compatibility surface in `@owlat/shared`. Shared owns the *types* and the
 * *extension registries* (so a custom client or plugin compat list can plug in)
 * plus the static *client metadata* baseline. Per-block Feature compatibility
 * and Property compatibility live in Block modules inside
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

// Pluggable registries — register additional clients or feature rules at
// runtime without rebuilding the package.
export {
	emailClientRegistry,
	blockCompatibilityRegistry,
	registerEmailClient,
	unregisterEmailClient,
	registerBlockCompatibility,
	unregisterBlockCompatibility,
	getAllEmailClients,
	getEmailClientInfo,
	mergeBlockCompatibility,
	lookupClientSupport,
} from './registry';
