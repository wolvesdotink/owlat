import { ref, computed, type Ref, type ComputedRef } from 'vue';
import type {
	CompatibilityIssue,
	CompatibilityReport,
	CanIEmailFeature,
	EmailClient,
	SupportCode,
	AnalyzableBlock,
	NestingDepthResult,
} from '../types';
import { useCanIEmail } from './useCanIEmail';
import { emailClients, canIEmailFamilyMap, getCanIEmailPlatformCandidates } from '../data/clients';

/**
 * CSS properties and their caniemail feature slugs
 */
const cssFeatureMap: Record<string, string> = {
	'border-radius': 'css-border-radius',
	'box-shadow': 'css-box-shadow',
	'background-image': 'css-background-image',
	'background-size': 'css-background-size',
	'background-position': 'css-background-position',
	animation: 'css-animation',
	'animation-name': 'css-animation',
	'animation-duration': 'css-animation',
	transition: 'css-transition',
	transform: 'css-transform',
	'flex-direction': 'css-flex-direction',
	'justify-content': 'css-justify-content',
	'align-items': 'css-align-items',
	'flex-wrap': 'css-flex-wrap',
	display: 'css-display',
	grid: 'css-display-grid',
	'grid-template': 'css-grid-template',
	'max-width': 'css-max-width',
	'min-width': 'css-width',
	position: 'css-position',
	'text-shadow': 'css-text-shadow',
	'letter-spacing': 'css-letter-spacing',
	'line-height': 'css-line-height',
	opacity: 'css-opacity',
	float: 'css-float',
	'font-weight': 'css-font-weight',
	'text-align': 'css-text-align',
	'vertical-align': 'css-vertical-align',
	'list-style': 'css-list-style-type',
	'list-style-type': 'css-list-style-type',
	filter: 'css-filter',
	'object-fit': 'css-object-fit',
	'object-position': 'css-object-position',
	'clip-path': 'css-clip-path',
	'mix-blend-mode': 'css-mix-blend-mode',
	'text-decoration': 'css-text-decoration',
	'text-transform': 'css-text-transform',
	'word-wrap': 'css-overflow-wrap',
	'overflow-wrap': 'css-overflow-wrap',
};

/**
 * HTML elements and their caniemail feature slugs
 */
const htmlFeatureMap: Record<string, string> = {
	video: 'html-video',
	audio: 'html-audio',
	picture: 'html-picture',
	source: 'html-picture',
	svg: 'html-svg',
	form: 'html-form',
	input: 'html-input-checkbox',
	button: 'html-button-reset',
	select: 'html-select',
	textarea: 'html-textarea',
	dialog: 'html-dialog',
	meter: 'html-meter',
	progress: 'html-progress',
	abbr: 'html-abbr',
	address: 'html-address',
	bdi: 'html-bdi',
	blockquote: 'html-blockquote',
	code: 'html-code',
	del: 'html-del',
	dfn: 'html-dfn',
	pre: 'html-pre',
	small: 'html-small',
	wbr: 'html-wbr',
};

/**
 * Common problematic patterns with friendly descriptions
 */
const problematicPatterns: Array<{
	pattern: RegExp;
	message: string;
	severity: 'error' | 'warning' | 'info';
	feature?: string;
}> = [
	{
		pattern: /display\s*:\s*flex/i,
		message: 'Flexbox is not supported in Outlook (Windows) and some older clients',
		severity: 'warning',
		feature: 'css-display-flex',
	},
	{
		pattern: /display\s*:\s*grid/i,
		message: 'CSS Grid is not supported in most email clients',
		severity: 'error',
		feature: 'css-display-grid',
	},
	{
		pattern: /position\s*:\s*(absolute|fixed)/i,
		message: 'Absolute/fixed positioning is poorly supported in email clients',
		severity: 'warning',
		feature: 'css-position',
	},
	{
		pattern: /@media\s*\(/i,
		message: 'Media queries have limited support in Gmail and some clients',
		severity: 'info',
		feature: 'css-at-media',
	},
	{
		pattern: /background-image\s*:\s*url/i,
		message: 'Background images are not supported in Outlook (Windows)',
		severity: 'warning',
		feature: 'css-background-image',
	},
	{
		pattern: /<video/i,
		message: 'Video elements are not supported in most email clients',
		severity: 'error',
		feature: 'html-video',
	},
	{
		pattern: /<audio/i,
		message: 'Audio elements are not supported in most email clients',
		severity: 'error',
		feature: 'html-audio',
	},
	{
		pattern: /<svg/i,
		message: 'Inline SVG has limited support across email clients',
		severity: 'warning',
		feature: 'html-svg',
	},
	{
		pattern: /<form/i,
		message: 'Forms are not supported in most email clients',
		severity: 'error',
		feature: 'html-form',
	},
	{
		pattern: /margin\s*:\s*auto/i,
		message: 'margin: auto may not work correctly in all clients',
		severity: 'info',
	},
	{
		pattern: /:hover/i,
		message: 'Hover states are not supported in Gmail and mobile clients',
		severity: 'info',
		feature: 'css-pseudo-class-hover',
	},
	{
		pattern: /@font-face/i,
		message: 'Custom web fonts may not load in many email clients',
		severity: 'warning',
		feature: 'css-at-font-face',
	},
];

interface AnalysisOptions {
	clients?: EmailClient[];
	checkAllClients?: boolean;
}

/** Threshold for deep nesting warning (containers nested more than this level) */
const DEEP_NESTING_THRESHOLD = 2;

/**
 * Calculate the maximum container nesting depth in a single block
 */
function calculateBlockNestingDepth(block: AnalyzableBlock, currentDepth = 0): number {
	// Only containers contribute to nesting depth
	if (block.type !== 'container') {
		// For columns, check items inside each column
		if (block.type === 'columns' && block.content.columns) {
			let maxColumnDepth = currentDepth;
			for (const column of block.content.columns) {
				for (const item of column) {
					if (item && typeof item === 'object' && 'type' in item && 'content' in item) {
						const itemDepth = calculateBlockNestingDepth(item as AnalyzableBlock, currentDepth);
						maxColumnDepth = Math.max(maxColumnDepth, itemDepth);
					}
				}
			}
			return maxColumnDepth;
		}
		return currentDepth;
	}

	// Container found - increment depth
	const containerDepth = currentDepth + 1;
	let maxChildDepth = containerDepth;

	// Check container items
	const items = block.content.items;
	if (items && Array.isArray(items)) {
		for (const item of items) {
			const itemDepth = calculateBlockNestingDepth(item, containerDepth);
			maxChildDepth = Math.max(maxChildDepth, itemDepth);
		}
	}

	return maxChildDepth;
}

/**
 * Calculate maximum nesting depth across all blocks
 */
export function calculateNestingDepth(blocks: AnalyzableBlock[]): NestingDepthResult {
	let maxDepth = 0;

	for (const block of blocks) {
		const blockDepth = calculateBlockNestingDepth(block, 0);
		maxDepth = Math.max(maxDepth, blockDepth);
	}

	const hasDeepNesting = maxDepth > DEEP_NESTING_THRESHOLD;
	const warningMessage = hasDeepNesting
		? `Container nesting depth of ${maxDepth} exceeds recommended maximum of ${DEEP_NESTING_THRESHOLD}. This may cause rendering issues in some email clients like Outlook.`
		: undefined;

	return {
		maxDepth,
		hasDeepNesting,
		warningMessage,
	};
}

/**
 * Composable for analyzing email HTML compatibility
 */
export function useCompatibilityAnalysis(): {
	isAnalyzing: Ref<boolean>;
	report: Ref<CompatibilityReport | null>;
	issues: ComputedRef<CompatibilityIssue[]>;
	score: ComputedRef<number>;
	analyzeHtml: (html: string, options?: AnalysisOptions) => Promise<CompatibilityReport>;
	analyzeNestingDepth: (blocks: AnalyzableBlock[]) => NestingDepthResult;
	getClientSupport: (feature: CanIEmailFeature, client: EmailClient) => SupportCode | null;
	getUnsupportedClients: (feature: CanIEmailFeature, clients?: EmailClient[]) => EmailClient[];
} {
	const { fetchData, getFeatureBySlug, getFeatureSupport, features, error: canIEmailError } =
		useCanIEmail();

	const isAnalyzing = ref(false);
	const report = ref<CompatibilityReport | null>(null);

	const issues = computed(() => report.value?.issues ?? []);
	const score = computed(() => report.value?.score ?? 100);

	/**
	 * Get support level for a feature on a specific client
	 */
	function getClientSupport(feature: CanIEmailFeature, client: EmailClient): SupportCode | null {
		const canIEmailFamilies = canIEmailFamilyMap[client.family] ?? [client.family];
		const canIEmailPlatforms = getCanIEmailPlatformCandidates(client.id, client.platform);

		for (const family of canIEmailFamilies) {
			const support = getFeatureSupport(feature, family, canIEmailPlatforms);
			if (support !== null) {
				return support;
			}
		}

		return null;
	}

	/**
	 * Get list of clients that don't support a feature
	 */
	function getUnsupportedClients(
		feature: CanIEmailFeature,
		clients: EmailClient[] = emailClients
	): EmailClient[] {
		return clients.filter((client) => {
			const support = getClientSupport(feature, client);
			return support === 'n' || support === 'a';
		});
	}

	/**
	 * Extract CSS properties from HTML
	 */
	function extractCssProperties(html: string): string[] {
		const properties: string[] = [];
		const styleRegex = /style\s*=\s*["']([^"']+)["']/gi;
		const styleTagRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;

		// Extract inline styles
		let match;
		while ((match = styleRegex.exec(html)) !== null) {
			const styles = match[1];
			if (styles) {
				const propRegex = /([a-z-]+)\s*:/gi;
				let propMatch;
				while ((propMatch = propRegex.exec(styles)) !== null) {
					const prop = propMatch[1];
					if (prop) properties.push(prop.toLowerCase());
				}
			}
		}

		// Extract style tag contents
		while ((match = styleTagRegex.exec(html)) !== null) {
			const styles = match[1];
			if (styles) {
				const propRegex = /([a-z-]+)\s*:/gi;
				let propMatch;
				while ((propMatch = propRegex.exec(styles)) !== null) {
					const prop = propMatch[1];
					if (prop) properties.push(prop.toLowerCase());
				}
			}
		}

		return [...new Set(properties)];
	}

	/**
	 * Extract HTML elements from HTML
	 */
	function extractHtmlElements(html: string): string[] {
		const elements: string[] = [];
		const tagRegex = /<([a-z][a-z0-9]*)/gi;

		let match;
		while ((match = tagRegex.exec(html)) !== null) {
			const tag = match[1];
			if (tag) elements.push(tag.toLowerCase());
		}

		return [...new Set(elements)];
	}

	/**
	 * Analyze HTML for compatibility issues
	 */
	async function analyzeHtml(
		html: string,
		options: AnalysisOptions = {}
	): Promise<CompatibilityReport> {
		isAnalyzing.value = true;

		try {
			// Ensure caniemail data is loaded
			await fetchData();

			const clientsToCheck = options.clients ?? emailClients;
			const foundIssues: CompatibilityIssue[] = [];
			const hasCanIEmailData = features.value.length > 0;

			if (!hasCanIEmailData) {
				foundIssues.push({
					severity: 'warning',
					feature: 'caniemail-data',
					message: canIEmailError.value
						? `Can I Email data could not be loaded (${canIEmailError.value.message}). Results are heuristic-only.`
						: 'Can I Email data is unavailable. Results are heuristic-only.',
					clients: [],
				});
			}

			// Check for problematic patterns
			for (const { pattern, message, severity, feature } of problematicPatterns) {
				if (pattern.test(html)) {
					const affectedClients: string[] = [];

					if (feature && hasCanIEmailData) {
						const featureData = getFeatureBySlug(feature);
						if (featureData) {
							const unsupported = getUnsupportedClients(featureData, clientsToCheck);
							affectedClients.push(...unsupported.map((c) => c.name));
						}
					}

					foundIssues.push({
						severity,
						feature: feature ?? 'unknown',
						message,
						clients: affectedClients,
					});
				}
			}

			// Check CSS properties against caniemail data
			const cssProps = extractCssProperties(html);
			for (const prop of cssProps) {
				const featureSlug = cssFeatureMap[prop];
				if (featureSlug && hasCanIEmailData) {
					const feature = getFeatureBySlug(featureSlug);
					if (feature) {
						const unsupported = getUnsupportedClients(feature, clientsToCheck);
						if (unsupported.length > 0) {
							// Avoid duplicate issues
							const existingIssue = foundIssues.find((i) => i.feature === featureSlug);
							if (!existingIssue) {
								foundIssues.push({
									severity: unsupported.length > 3 ? 'warning' : 'info',
									feature: featureSlug,
									message: `${feature.title} may not work in some clients`,
									clients: unsupported.map((c) => c.name),
									cssProperty: prop,
								});
							}
						}
					}
				}
			}

			// Check HTML elements against caniemail data
			const htmlElements = extractHtmlElements(html);
			for (const element of htmlElements) {
				const featureSlug = htmlFeatureMap[element];
				if (featureSlug && hasCanIEmailData) {
					const feature = getFeatureBySlug(featureSlug);
					if (feature) {
						const unsupported = getUnsupportedClients(feature, clientsToCheck);
						if (unsupported.length > 0) {
							// Avoid duplicate issues
							const existingIssue = foundIssues.find((i) => i.feature === featureSlug);
							if (!existingIssue) {
								foundIssues.push({
									severity: unsupported.length > 5 ? 'error' : 'warning',
									feature: featureSlug,
									message: `<${element}> element has limited support`,
									clients: unsupported.map((c) => c.name),
									htmlElement: element,
								});
							}
						}
					}
				}
			}

			// Calculate compatibility score
			const errorCount = foundIssues.filter((i) => i.severity === 'error').length;
			const warningCount = foundIssues.filter((i) => i.severity === 'warning').length;
			const infoCount = foundIssues.filter((i) => i.severity === 'info').length;

			const calculatedScore = Math.max(
				0,
				100 - errorCount * 20 - warningCount * 10 - infoCount * 2
			);

			const newReport: CompatibilityReport = {
				score: calculatedScore,
				issues: foundIssues.sort((a, b) => {
					const severityOrder = { error: 0, warning: 1, info: 2 };
					return severityOrder[a.severity] - severityOrder[b.severity];
				}),
				testedClients: clientsToCheck.map((c) => c.name),
				timestamp: new Date(),
			};

			report.value = newReport;
			return newReport;
		} finally {
			isAnalyzing.value = false;
		}
	}

	/**
	 * Analyze blocks for container nesting depth
	 */
	function analyzeNestingDepth(blocks: AnalyzableBlock[]): NestingDepthResult {
		return calculateNestingDepth(blocks);
	}

	return {
		isAnalyzing,
		report,
		issues,
		score,
		analyzeHtml,
		analyzeNestingDepth,
		getClientSupport,
		getUnsupportedClients,
	};
}
