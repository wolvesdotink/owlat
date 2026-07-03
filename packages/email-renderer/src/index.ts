export { renderEmailHtml, renderBlockFragment } from './renderer';
export { renderAmpEmail } from './amp';
export { diffEmails } from './diff';
export type { EmailDiff, EmailDiffChange } from './diff';
export { analyzeEmail, getEmailHealthScore, suggestOptimizations } from './analyzer';
export { renderPlainText } from './plaintext';
export { validateBlocks, ValidationError } from './validator';
export { inlineCss } from './inliner';
export { registerBlock, unregisterBlock, getRegisteredBlocks, finalizeRegistry, isRegistryFinalized } from './blocks';
export type { BlockRenderer } from './blocks';
export {
	registerBlockModule,
	unregisterBlockModule,
	finalizeBlockRegistry,
	isBlockRegistryFrozen,
	moduleFor,
	registeredBlockTypes,
} from './blocks/_registry';
export type {
	BlockModule,
	BlockOf,
	ContentOf,
	Placement,
	RenderArgs,
	PlainArgs,
	AmpArgs,
	ValidateArgs,
	HtmlWalk,
	PlaintextWalk,
} from './blocks/_module';
export {
	simulateClient,
	registerClientSimulator,
	unregisterClientSimulator,
	clientSimulators,
} from './simulators';
export type { ClientSimulator } from './simulators';
export type { RenderOptions, RenderContext, TargetClient, ValidationLevel, EmailHealthScore, EmailHealthRecommendation, GmailAnnotations } from './types';
export type { EmailAnalysis, EmailSizeBreakdown, OptimizationSuggestion } from './analyzer';
export type { ValidationIssue, ValidateOptions } from './validator';
export { escapeHtml, escapeAttr, escapeCss, sanitizeUrl, sanitizeCss, sanitizeRawHtml } from './sanitize';

// Compatibility — per-block data owned by Block modules, surfaced via the
// Compatibility walker. Plugin extension points (registerEmailClient,
// registerBlockCompatibility) still live in @owlat/shared.
export {
	getBlockCompatibility,
	getPropertyCompatibility,
	getCriticalProperties,
	getHandledFeatures,
	getClientIssues,
	getClientPropertyIssues,
	getAudienceReach,
	scoreBlockCompatibility,
	getBlockLimitationSummary,
	getSafeBlockConfig,
	checkPropertyCompatibility,
	featuresFor,
	propertiesFor,
	allBlockTypes,
	allFeatures,
	allProperties,
} from './compatibility';
export type { BlockTaggedFeature, BlockTaggedProperty, BlockLimitation } from './compatibility';
