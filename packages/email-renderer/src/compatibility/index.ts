/**
 * Compatibility surface for `@owlat/email-renderer` — scoring and audience-reach
 * math. Per-block data lives in Block modules; this surface reads through the
 * Compatibility walker.
 */

export {
	getBlockCompatibility,
	getPropertyCompatibility,
	getAudienceReach,
	scoreBlockCompatibility,
} from './scoring';

export { featuresFor, propertiesFor } from './walker';
