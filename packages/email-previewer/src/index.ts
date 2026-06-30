// ============================================================
// @owlat/email-previewer
// Email preview component with cross-client compatibility analysis
// ============================================================

// Components
export {
	EmailPreviewer,
	ClientSelector,
	DeviceFrame,
	AnalysisPanel,
	RenderOptionsPanel,
	DiffPanel,
} from './components';

// Composables
export { useCanIEmail, useCompatibilityAnalysis, calculateNestingDepth } from './composables';

// Types
export type {
	// caniemail types
	SupportCode,
	CanIEmailNicenames,
	FeatureStats,
	CanIEmailFeature,
	CanIEmailData,
	FeatureSupportResult,
	// Client types
	EmailClientFamily,
	EmailPlatform,
	EmailClient,
	EmailClientGroup,
	DevicePreset,
	PreviewSettings,
	// Component types
	EmailPreviewerProps,
	CompatibilityIssue,
	CompatibilityReport,
	// Nesting depth types
	AnalyzableBlock,
	NestingDepthResult,
	// Analysis types
	PreviewEmailAnalysis,
	PreviewEmailSizeBreakdown,
	PreviewOptimizationSuggestion,
	PreviewHealthScore,
	PreviewHealthRecommendation,
	PreviewValidationIssue,
	PreviewEmailDiff,
	PreviewEmailDiffChange,
	PreviewRenderOptions,
} from './types';

// Data
export {
	emailClients,
	emailClientGroups,
	devicePresets,
	popularClients,
	getClientById,
	getDeviceById,
} from './data';
