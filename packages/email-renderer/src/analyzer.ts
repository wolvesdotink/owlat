/**
 * Email size and quality analyzer.
 * Provides metrics and warnings for rendered email HTML.
 */

import type { EditorBlock, ClientSupport, CommonBlockProperties } from '@owlat/shared';
import { GMAIL_CLIP_BYTES, GMAIL_CSS_LIMIT_BYTES, GMAIL_CSS_WARNING_BYTES } from '@owlat/shared/emailLimits';
import { scoreBlockCompatibility } from './compatibility';
import { validateBlocks } from './validator';
import type { EmailHealthScore, EmailHealthRecommendation, RenderOptions } from './types';

export interface EmailSizeBreakdown {
	/** Total HTML size in bytes */
	totalBytes: number;
	/** Size of <style> block content in bytes */
	styleBlockBytes: number;
	/** Size of MSO/VML conditional content in bytes */
	msoConditionalBytes: number;
	/** Size of all <img> tags in bytes */
	imageTagBytes: number;
	/** Size of visible text content in bytes */
	textContentBytes: number;
	/** Size of whitespace (spaces, newlines, tabs) in bytes */
	whitespaceBytes: number;
	/** Size of HTML tags and attributes (excluding above categories) in bytes */
	markupOverheadBytes: number;
}

export interface OptimizationSuggestion {
	/** What the optimization does */
	description: string;
	/** Estimated bytes saved */
	estimatedSavings: number;
	/** Category of optimization */
	category: 'minification' | 'vml' | 'css' | 'images' | 'content';
}

export interface EmailAnalysis {
	/** Total HTML size in bytes */
	htmlSizeBytes: number;
	/** Whether the email exceeds Gmail's 102KB clipping threshold */
	exceedsGmailClip: boolean;
	/** Maximum table nesting depth */
	tableNestingDepth: number;
	/** Total number of images */
	imageCount: number;
	/** Total number of links (<a> tags) */
	linkCount: number;
	/** Whether the email contains any text content (not image-only) */
	hasTextContent: boolean;
	/** Ratio of text characters to image count (higher is better for deliverability) */
	textToImageRatio: number;
	/** Count of display:none elements beyond the preheader divs */
	displayNoneCount: number;
	/** Warnings and recommendations */
	warnings: string[];
	/** Detailed size breakdown by content category */
	sizeBreakdown?: EmailSizeBreakdown;
	/** Optimization suggestions with estimated savings */
	optimizations?: OptimizationSuggestion[];
	/** Whether the email exceeds Gmail's ~8KB CSS size limit (styles get stripped) */
	exceedsGmailCssLimit?: boolean;
	/** Size of the <style> block content in bytes */
	styleBlockSizeBytes?: number;
	/** Basic CSS syntax issues found */
	cssValidationIssues?: string[];
}

const GMAIL_CLIP_THRESHOLD = GMAIL_CLIP_BYTES;

/**
 * Calculate maximum table nesting depth in HTML.
 */
const getTableNestingDepth = (html: string): number => {
	let maxDepth = 0;
	let currentDepth = 0;
	const regex = /<\/?table[\s>]/gi;
	let match: RegExpExecArray | null;

	while ((match = regex.exec(html)) !== null) {
		if (match[0].startsWith('</')) {
			currentDepth--;
		} else {
			currentDepth++;
			maxDepth = Math.max(maxDepth, currentDepth);
		}
	}

	return maxDepth;
};

/**
 * Count images in HTML.
 */
const getImageCount = (html: string): number => {
	const matches = html.match(/<img\s/gi);
	return matches ? matches.length : 0;
};

/**
 * Count links (<a> tags) in HTML.
 */
const getLinkCount = (html: string): number => {
	const matches = html.match(/<a\s/gi);
	return matches ? matches.length : 0;
};

/**
 * Extract visible text content from HTML (strip tags, decode entities).
 */
const getTextContent = (html: string): string => {
	return html
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&#\d+;/g, ' ')
		.replace(/&\w+;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
};

/**
 * Count display:none occurrences beyond the expected preheader divs.
 */
const getDisplayNoneCount = (html: string): number => {
	const matches = html.match(/display:\s*none/gi);
	const total = matches ? matches.length : 0;
	// Preheader uses 2 display:none divs + checkbox inputs use display:none
	return Math.max(0, total - 2);
};

/**
 * Calculate email size breakdown by content category.
 */
const getSizeBreakdown = (html: string): EmailSizeBreakdown => {
	const encoder = new TextEncoder();
	const totalBytes = encoder.encode(html).length;

	// Style block
	const styleMatch = html.match(/<style>[\s\S]*?<\/style>/gi);
	const styleBlockBytes = styleMatch
		? styleMatch.reduce((sum, s) => sum + encoder.encode(s).length, 0)
		: 0;

	// MSO/VML conditional content
	const msoMatch = html.match(/<!--\[if[^\]]*\]>[\s\S]*?<!\[endif\]-->/gi);
	const msoConditionalBytes = msoMatch
		? msoMatch.reduce((sum, s) => sum + encoder.encode(s).length, 0)
		: 0;

	// Image tags
	const imgMatch = html.match(/<img[^>]*>/gi);
	const imageTagBytes = imgMatch
		? imgMatch.reduce((sum, s) => sum + encoder.encode(s).length, 0)
		: 0;

	// Text content (strip all tags)
	const textOnly = html
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/\s+/g, ' ')
		.trim();
	const textContentBytes = encoder.encode(textOnly).length;

	// Whitespace
	const whitespaceOnly = html.replace(/[^\s]/g, '');
	const whitespaceBytes = encoder.encode(whitespaceOnly).length;

	// Markup overhead = total - everything else
	const markupOverheadBytes = Math.max(0,
		totalBytes - styleBlockBytes - msoConditionalBytes - imageTagBytes - textContentBytes - whitespaceBytes
	);

	return {
		totalBytes,
		styleBlockBytes,
		msoConditionalBytes,
		imageTagBytes,
		textContentBytes,
		whitespaceBytes,
		markupOverheadBytes,
	};
};

/**
 * Generate optimization suggestions based on the email HTML.
 */
export const suggestOptimizations = (html: string): OptimizationSuggestion[] => {
	const suggestions: OptimizationSuggestion[] = [];
	const breakdown = getSizeBreakdown(html);

	// Minification savings estimate
	if (breakdown.whitespaceBytes > 1024) {
		suggestions.push({
			description: 'Minify HTML to collapse whitespace and remove comments',
			estimatedSavings: Math.round(breakdown.whitespaceBytes * 0.7),
			category: 'minification',
		});
	}

	// VML/MSO savings
	if (breakdown.msoConditionalBytes > 2048) {
		const kb = Math.round(breakdown.msoConditionalBytes / 1024);
		suggestions.push({
			description: `Remove VML/MSO conditional blocks (${kb}KB). Only do this if Outlook rendering is not a priority.`,
			estimatedSavings: breakdown.msoConditionalBytes,
			category: 'vml',
		});
	}

	// CSS savings
	if (breakdown.styleBlockBytes > 4096) {
		suggestions.push({
			description: 'Inline CSS and remove the <style> block for clients that strip it anyway',
			estimatedSavings: Math.round(breakdown.styleBlockBytes * 0.4),
			category: 'css',
		});
	}

	// Image tag optimization
	const dataUriMatches = html.match(/src="data:[^"]+"/gi);
	if (dataUriMatches) {
		const dataUriBytes = dataUriMatches.reduce((sum, s) => sum + s.length, 0);
		if (dataUriBytes > 2048) {
			suggestions.push({
				description: 'Replace inline data URIs with hosted image URLs',
				estimatedSavings: dataUriBytes,
				category: 'images',
			});
		}
	}

	// Duplicate inline styles
	const styleAttrMatches = html.match(/style="[^"]+"/gi);
	if (styleAttrMatches && styleAttrMatches.length > 20) {
		const styleSet = new Set(styleAttrMatches);
		const duplicates = styleAttrMatches.length - styleSet.size;
		if (duplicates > 10) {
			suggestions.push({
				description: `Consolidate ${duplicates} duplicate inline style declarations into CSS classes`,
				estimatedSavings: duplicates * 40,
				category: 'css',
			});
		}
	}

	return suggestions;
};

/**
 * Analyze rendered email HTML for potential issues.
 */
export const analyzeEmail = (html: string, options?: { subjectLine?: string; includeBreakdown?: boolean }): EmailAnalysis => {
	const htmlSizeBytes = new TextEncoder().encode(html).length;
	const exceedsGmailClip = htmlSizeBytes > GMAIL_CLIP_THRESHOLD;
	const tableNestingDepth = getTableNestingDepth(html);
	const imageCount = getImageCount(html);
	const linkCount = getLinkCount(html);
	const textContent = getTextContent(html);
	const hasTextContent = textContent.length > 50;
	const textToImageRatio = imageCount > 0 ? Math.round(textContent.length / imageCount) : textContent.length > 0 ? Infinity : 0;
	const displayNoneCount = getDisplayNoneCount(html);

	const warnings: string[] = [];

	if (exceedsGmailClip) {
		const sizeKb = Math.round(htmlSizeBytes / 1024);
		warnings.push(`Email size (${sizeKb}KB) exceeds Gmail's 102KB clipping threshold. Content after 102KB will be hidden behind a "View entire message" link.`);
	}

	if (tableNestingDepth > 10) {
		warnings.push(`High table nesting depth (${tableNestingDepth}). Some email clients may have rendering issues with deeply nested tables. Consider simplifying the layout.`);
	}

	if (imageCount > 20) {
		warnings.push(`High image count (${imageCount}). Emails with many images may be slow to load or flagged by spam filters.`);
	}

	if (htmlSizeBytes > 80 * 1024 && !exceedsGmailClip) {
		const sizeKb = Math.round(htmlSizeBytes / 1024);
		warnings.push(`Email size (${sizeKb}KB) is approaching Gmail's 102KB clipping threshold. Consider optimizing content.`);
	}

	if (linkCount > 60) {
		warnings.push(`High link count (${linkCount}). Emails with excessive links may trigger spam filters.`);
	}

	if (!hasTextContent && imageCount > 0) {
		warnings.push('Email appears to be image-only with minimal text content. This harms deliverability and accessibility.');
	}

	if (imageCount > 0 && textToImageRatio < 50) {
		warnings.push(`Low text-to-image ratio (${textToImageRatio} chars per image). Consider adding more text content for better deliverability.`);
	}

	if (displayNoneCount > 3) {
		warnings.push(`Found ${displayNoneCount} display:none elements beyond preheader. Excessive hidden content can trigger spam filters.`);
	}

	// Check for potential issues
	if (html.includes('position:absolute') || html.includes('position: absolute')) {
		warnings.push('Email contains position:absolute — this is stripped by Gmail and some other clients.');
	}

	if (html.includes('<form') || html.includes('<input')) {
		warnings.push('Email contains form elements — these are stripped by most email clients except Apple Mail/iOS.');
	}

	if (html.includes('<video') || html.includes('<audio')) {
		warnings.push('Email contains <video> or <audio> tags — only supported in Apple Mail/iOS. Use thumbnail + link pattern instead.');
	}

	// Subject line analysis
	if (options?.subjectLine) {
		if (options.subjectLine.length > 70) {
			warnings.push(`Subject line is ${options.subjectLine.length} chars — may be truncated in Gmail (70 char limit).`);
		}
		if (options.subjectLine === options.subjectLine.toUpperCase() && /[A-Z]/.test(options.subjectLine)) {
			warnings.push('Subject line is ALL CAPS — this can trigger spam filters.');
		}
	}

	// Gmail CSS size guard
	const styleMatches = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
	const styleContent = styleMatches
		? styleMatches.map(s => s.replace(/<\/?style[^>]*>/gi, '')).join('')
		: '';
	const styleBlockSizeBytes = new TextEncoder().encode(styleContent).length;
	const exceedsGmailCssLimit = styleBlockSizeBytes > GMAIL_CSS_THRESHOLD;

	if (exceedsGmailCssLimit) {
		const sizeKb = Math.round(styleBlockSizeBytes / 1024);
		warnings.push(`CSS style block (${sizeKb}KB) exceeds Gmail's ~8KB limit. Gmail will strip the entire <style> block, breaking responsive layout and dark mode. Enable CSS inlining.`);
	} else if (styleBlockSizeBytes > GMAIL_CSS_WARNING_THRESHOLD) {
		const percent = Math.round((styleBlockSizeBytes / GMAIL_CSS_THRESHOLD) * 100);
		warnings.push(`CSS style block is at ${percent}% of Gmail's ~8KB limit. Consider reducing CSS to avoid Gmail stripping styles.`);
	}

	// Basic CSS syntax validation
	const cssValidationIssues: string[] = [];
	const openBraces = (styleContent.match(/{/g) || []).length;
	const closeBraces = (styleContent.match(/}/g) || []).length;
	if (openBraces !== closeBraces) {
		cssValidationIssues.push(`Unbalanced braces in CSS: ${openBraces} opening vs ${closeBraces} closing`);
	}
	const unclosedStrings = styleContent.match(/'[^']*$|"[^"]*$/gm);
	if (unclosedStrings) {
		cssValidationIssues.push('Possible unclosed string in CSS');
	}
	if (cssValidationIssues.length > 0) {
		warnings.push(`CSS syntax issues: ${cssValidationIssues.join('; ')}`);
	}

	const result: EmailAnalysis = {
		htmlSizeBytes,
		exceedsGmailClip,
		tableNestingDepth,
		imageCount,
		linkCount,
		hasTextContent,
		textToImageRatio,
		displayNoneCount,
		warnings,
		exceedsGmailCssLimit,
		styleBlockSizeBytes,
		cssValidationIssues: cssValidationIssues.length > 0 ? cssValidationIssues : undefined,
	};

	// Include detailed breakdown on request
	if (options?.includeBreakdown) {
		result.sizeBreakdown = getSizeBreakdown(html);
		result.optimizations = suggestOptimizations(html);
	}

	return result;
};

// ============================================================
// Gmail CSS size constants
// ============================================================

const GMAIL_CSS_THRESHOLD = GMAIL_CSS_LIMIT_BYTES;
const GMAIL_CSS_WARNING_THRESHOLD = GMAIL_CSS_WARNING_BYTES;

// ============================================================
// Email Health Score
// ============================================================

/** Calculate a comprehensive email health score across multiple dimensions */
export const getEmailHealthScore = (
	blocks: EditorBlock[],
	html: string,
	_options?: RenderOptions,
): EmailHealthScore => {
	const recommendations: EmailHealthRecommendation[] = [];

	// --- 1. Compatibility score ---
	let compatTotal = 0;
	let compatCount = 0;
	for (const block of blocks) {
		const content = block.content as CommonBlockProperties;
		const score = scoreBlockCompatibility(block.type, content as unknown as Record<string, unknown>);
		compatTotal += score.score;
		compatCount++;
		if (score.criticalIssues.length > 0) {
			recommendations.push({
				category: 'compatibility',
				message: `${block.type} block has critical issues: ${score.criticalIssues[0]}`,
				impact: 'high',
			});
		}
	}
	const compatibility = compatCount > 0 ? Math.round(compatTotal / compatCount) : 100;

	// --- 2. Accessibility score ---
	const a11yResult = validateBlocks(blocks, { accessibilityAudit: true, level: 'soft' });
	const a11yIssues = a11yResult.issues.filter(i => i.code.startsWith('A11Y_'));
	const a11yErrors = a11yIssues.filter(i => i.severity === 'error').length;
	const a11yWarnings = a11yIssues.filter(i => i.severity === 'warning').length;
	const accessibility = Math.max(0, 100 - (a11yErrors * 20) - (a11yWarnings * 10));
	if (a11yErrors > 0) {
		recommendations.push({
			category: 'accessibility',
			message: `${a11yErrors} accessibility error(s) found — fix contrast ratios and missing alt text`,
			impact: 'high',
		});
	}
	if (a11yWarnings > 0) {
		recommendations.push({
			category: 'accessibility',
			message: `${a11yWarnings} accessibility warning(s) — improve link text and heading hierarchy`,
			impact: 'medium',
		});
	}

	// --- 3. Deliverability score ---
	const analysis = analyzeEmail(html);
	let deliverability = 100;
	if (analysis.exceedsGmailClip) {
		deliverability -= 30;
		recommendations.push({
			category: 'deliverability',
			message: 'Email exceeds Gmail 102KB clip threshold — content will be hidden',
			impact: 'high',
		});
	}
	if (!analysis.hasTextContent) {
		deliverability -= 25;
		recommendations.push({
			category: 'deliverability',
			message: 'Email is image-only — add text content for deliverability',
			impact: 'high',
		});
	}
	if (analysis.imageCount > 0 && analysis.textToImageRatio < 50) {
		deliverability -= 15;
		recommendations.push({
			category: 'deliverability',
			message: 'Low text-to-image ratio — add more text content',
			impact: 'medium',
		});
	}
	if (analysis.displayNoneCount > 3) {
		deliverability -= 10;
	}
	if (analysis.linkCount > 60) {
		deliverability -= 10;
		recommendations.push({
			category: 'deliverability',
			message: `High link count (${analysis.linkCount}) — may trigger spam filters`,
			impact: 'medium',
		});
	}
	if (analysis.exceedsGmailCssLimit) {
		deliverability -= 15;
		recommendations.push({
			category: 'deliverability',
			message: 'CSS exceeds Gmail 8KB limit — styles will be stripped',
			impact: 'high',
		});
	}
	deliverability = Math.max(0, deliverability);

	// --- 4. Outlook support score ---
	const outlookClients: (keyof ClientSupport)[] = ['outlookDesktop', 'outlook365', 'outlookNew', 'outlookMac'];
	let outlookTotal = 0;
	let outlookCount = 0;
	for (const block of blocks) {
		const content = block.content as CommonBlockProperties;
		const score = scoreBlockCompatibility(block.type, content as unknown as Record<string, unknown>);

		// Count Outlook clients in full/partial support
		for (const client of outlookClients) {
			outlookCount++;
			if (score.fullSupportClients.includes(client)) {
				outlookTotal += 100;
			} else if (score.partialSupportClients.includes(client)) {
				outlookTotal += 70;
			}
		}
	}
	const outlookSupport = outlookCount > 0 ? Math.round(outlookTotal / outlookCount) : 100;
	if (outlookSupport < 70) {
		recommendations.push({
			category: 'outlook',
			message: 'Outlook compatibility is low — check VML fallbacks and avoid CSS-only features',
			impact: 'high',
		});
	}

	// --- Overall weighted composite ---
	const overall = Math.round(
		compatibility * 0.35 +
		accessibility * 0.20 +
		deliverability * 0.30 +
		outlookSupport * 0.15,
	);

	return {
		overall,
		compatibility,
		accessibility,
		deliverability,
		outlookSupport,
		recommendations,
	};
};
