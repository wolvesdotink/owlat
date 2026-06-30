/**
 * Compatibility surface for `@owlat/email-renderer` — scoring, audience-reach
 * math, and builder UI helpers. Per-block data lives in Block modules; this
 * surface reads through the Compatibility walker.
 */

export {
	getBlockCompatibility,
	getPropertyCompatibility,
	getCriticalProperties,
	getHandledFeatures,
	getClientIssues,
	getClientPropertyIssues,
	getAudienceReach,
	scoreBlockCompatibility,
} from './scoring';
export type { BlockTaggedFeature, BlockTaggedProperty } from './scoring';

export {
	getBlockLimitationSummary,
	getSafeBlockConfig,
	checkPropertyCompatibility,
} from './ui';
export type { BlockLimitation } from './ui';

export { featuresFor, propertiesFor, allBlockTypes, allFeatures, allProperties } from './walker';
