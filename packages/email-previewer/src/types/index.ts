// caniemail types
export type {
	SupportCode,
	CanIEmailNicenames,
	FeatureStats,
	CanIEmailFeature,
	CanIEmailData,
	FeatureSupportResult,
} from './caniemail';

// Client types
export type {
	EmailClientFamily,
	EmailPlatform,
	EmailClient,
	EmailClientGroup,
	DevicePreset,
	PreviewSettings,
} from './clients';

// Component props/emits types
export interface EmailPreviewerProps {
	html: string;
	subject?: string;
	preheader?: string;
	showSendTest?: boolean;
}

export interface CompatibilityIssue {
	severity: 'error' | 'warning' | 'info';
	feature: string;
	message: string;
	clients: string[];
	cssProperty?: string;
	htmlElement?: string;
	line?: number;
}

export interface CompatibilityReport {
	score: number;
	issues: CompatibilityIssue[];
	testedClients: string[];
	timestamp: Date;
	/** Maximum container nesting depth found in blocks (if blocks provided) */
	nestingDepth?: number;
}

/**
 * Generic block structure for nesting depth analysis
 * Works with any block structure that has type and content
 */
export interface AnalyzableBlock {
	type: string;
	content: {
		items?: AnalyzableBlock[];
		columns?: Array<{ content: { items?: AnalyzableBlock[] } }[]>;
		[key: string]: unknown;
	};
}

/**
 * Result of nesting depth analysis
 */
export interface NestingDepthResult {
	maxDepth: number;
	hasDeepNesting: boolean;
	warningMessage?: string;
}

// ============================================================
// Preview-specific types (mirrors of renderer types to keep previewer decoupled)
// ============================================================

/**
 * Email size breakdown from renderer's analyzeEmail()
 */
export interface PreviewEmailSizeBreakdown {
	totalBytes: number;
	styleBlockBytes: number;
	msoConditionalBytes: number;
	imageTagBytes: number;
	textContentBytes: number;
	whitespaceBytes: number;
	markupOverheadBytes: number;
}

/**
 * Optimization suggestion from renderer
 */
export interface PreviewOptimizationSuggestion {
	description: string;
	estimatedSavings: number;
	category: 'minification' | 'vml' | 'css' | 'images' | 'content';
}

/**
 * Email analysis result from renderer's analyzeEmail()
 */
export interface PreviewEmailAnalysis {
	htmlSizeBytes: number;
	exceedsGmailClip: boolean;
	tableNestingDepth: number;
	imageCount: number;
	linkCount: number;
	hasTextContent: boolean;
	textToImageRatio: number;
	displayNoneCount: number;
	warnings: string[];
	sizeBreakdown?: PreviewEmailSizeBreakdown;
	optimizations?: PreviewOptimizationSuggestion[];
	exceedsGmailCssLimit?: boolean;
	styleBlockSizeBytes?: number;
	cssValidationIssues?: string[];
}

/**
 * Health score recommendation
 */
export interface PreviewHealthRecommendation {
	category: 'compatibility' | 'accessibility' | 'deliverability' | 'outlook';
	message: string;
	impact: 'high' | 'medium' | 'low';
}

/**
 * Email health score from renderer's getEmailHealthScore()
 */
export interface PreviewHealthScore {
	overall: number;
	compatibility: number;
	accessibility: number;
	deliverability: number;
	outlookSupport: number;
	recommendations: PreviewHealthRecommendation[];
}

/**
 * Validation issue from renderer's validateBlocks()
 */
export interface PreviewValidationIssue {
	blockId?: string;
	blockType?: string;
	severity: 'error' | 'warning' | 'info';
	code: string;
	message: string;
}

/**
 * Email diff change from renderer's diffEmails()
 */
export interface PreviewEmailDiffChange {
	type: 'added' | 'removed' | 'modified';
	category: 'text' | 'style' | 'image' | 'link' | 'structure' | 'meta';
	description: string;
	context?: string;
}

/**
 * Email diff result from renderer's diffEmails()
 */
export interface PreviewEmailDiff {
	identical: boolean;
	changes: PreviewEmailDiffChange[];
	sizeDelta: number;
	stats: {
		addedElements: number;
		removedElements: number;
		modifiedStyles: number;
		textChanges: number;
		linkChanges: number;
		imageChanges: number;
	};
}

/**
 * Render options that can be configured from the previewer UI
 */
export interface PreviewRenderOptions {
	baseWidth?: number;
	breakpoint?: number;
	fontUrls?: string[];
	customCss?: string;
	inlineCss?: boolean;
	variableValues?: Record<string, string>;
	targetClient?: 'gmail' | 'outlookDesktop' | 'outlookNew' | 'appleMail' | 'yahooMail';
	minify?: boolean;
	validationLevel?: 'skip' | 'soft' | 'strict';
	title?: string;
	preheaderText?: string;
	lang?: string;
	direction?: 'ltr' | 'rtl';
}
