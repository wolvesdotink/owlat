export { renderEmailHtml, renderBlockFragment } from './renderer';
export { renderAmpEmail } from './amp';
export { diffEmails } from './diff';
export type { EmailDiff, EmailDiffChange } from './diff';
export { diffTemplateVersions } from './templateDiff';
export type {
	BlockChange,
	FieldChange,
	MetaChange,
	TemplateDiff,
	TemplateDiffSide,
} from './templateDiff';
export { analyzeEmail, suggestOptimizations } from './analyzer';
export { getEmailHealthScore } from './emailHealthScore';
export { renderPlainText, resolvePlainText, hasPlainTextOverride } from './plaintext';
export { renderDraftBodies } from './draftBodies';
export type { DraftBodies, DraftBodySource, RenderDraftBodiesOptions } from './draftBodies';
export { validateBlocks, ValidationError } from './validator';
export { getContrastRatio } from './validators';
export { inlineCss } from './inliner';
export {
	registerBlock,
	unregisterBlock,
	getRegisteredBlocks,
	finalizeRegistry,
	isRegistryFinalized,
} from './blocks';
export type { BlockRenderer } from './blocks';
export {
	registerBlockModule,
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
export type {
	BlockChangeKind,
	RenderOptions,
	RenderContext,
	TargetClient,
	ValidationLevel,
	EmailHealthScore,
	EmailHealthRecommendation,
	GmailAnnotations,
} from './types';
export type { EmailAnalysis, EmailSizeBreakdown, OptimizationSuggestion } from './analyzer';
export type { ValidationIssue, ValidateOptions } from './validator';
export {
	escapeHtml,
	escapeAttr,
	escapeCss,
	sanitizeUrl,
	sanitizeCss,
	sanitizeRawHtml,
	sanitizeEditorHtml,
} from './sanitize';

// Compatibility — per-block data owned by Block modules, surfaced via the
// Compatibility walker. Plugin extension points (registerEmailClient,
// registerBlockCompatibility) still live in @owlat/shared.
export {
	getBlockCompatibility,
	getPropertyCompatibility,
	getAudienceReach,
	scoreBlockCompatibility,
	featuresFor,
	propertiesFor,
} from './compatibility';
