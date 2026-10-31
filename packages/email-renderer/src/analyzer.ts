/**
 * Email size and quality analyzer.
 * Provides metrics and warnings for rendered email HTML. The health score
 * built on these metrics is in `emailHealthScore.ts`.
 */

import {
	GMAIL_CLIP_BYTES,
	GMAIL_CSS_LIMIT_BYTES,
	GMAIL_CSS_WARNING_BYTES,
} from '@owlat/shared/emailLimits';

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
 * Strip HTML down to its visible text: drop <style>/<script> (and optionally
 * comments), remove tags, decode the basic entities, collapse whitespace, trim.
 *
 * The two call sites differ in three deliberate ways, so each is a flag:
 *  - `stripComments` — remove `<!-- ... -->` before dropping tags
 *  - `tagReplacement` — what a stripped tag leaves behind (' ' vs '')
 *  - `decodeAllEntities` — also turn numeric (`&#123;`) and named (`&copy;`)
 *    entities into spaces
 */
const stripToText = (
	html: string,
	opts: { stripComments?: boolean; tagReplacement?: string; decodeAllEntities?: boolean } = {}
): string => {
	const { stripComments = false, tagReplacement = ' ', decodeAllEntities = false } = opts;
	let s = html
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
	if (stripComments) {
		s = s.replace(/<!--[\s\S]*?-->/g, '');
	}
	s = s
		.replace(/<[^>]+>/g, tagReplacement)
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>');
	if (decodeAllEntities) {
		s = s.replace(/&#\d+;/g, ' ').replace(/&\w+;/g, ' ');
	}
	return s.replace(/\s+/g, ' ').trim();
};

/**
 * Extract visible text content from HTML (strip tags, decode entities).
 */
const getTextContent = (html: string): string => {
	return stripToText(html, { decodeAllEntities: true });
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
	const textOnly = stripToText(html, { stripComments: true, tagReplacement: '' });
	const textContentBytes = encoder.encode(textOnly).length;

	// Whitespace
	const whitespaceOnly = html.replace(/[^\s]/g, '');
	const whitespaceBytes = encoder.encode(whitespaceOnly).length;

	// Markup overhead = total - everything else
	const markupOverheadBytes = Math.max(
		0,
		totalBytes -
			styleBlockBytes -
			msoConditionalBytes -
			imageTagBytes -
			textContentBytes -
			whitespaceBytes
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
export const analyzeEmail = (
	html: string,
	options?: { subjectLine?: string; includeBreakdown?: boolean }
): EmailAnalysis => {
	const htmlSizeBytes = new TextEncoder().encode(html).length;
	const exceedsGmailClip = htmlSizeBytes > GMAIL_CLIP_THRESHOLD;
	const tableNestingDepth = getTableNestingDepth(html);
	const imageCount = getImageCount(html);
	const linkCount = getLinkCount(html);
	const textContent = getTextContent(html);
	const hasTextContent = textContent.length > 50;
	const textToImageRatio =
		imageCount > 0
			? Math.round(textContent.length / imageCount)
			: textContent.length > 0
				? Infinity
				: 0;
	const displayNoneCount = getDisplayNoneCount(html);

	const warnings: string[] = [];

	if (exceedsGmailClip) {
		const sizeKb = Math.round(htmlSizeBytes / 1024);
		warnings.push(
			`Email size (${sizeKb}KB) exceeds Gmail's 102KB clipping threshold. Content after 102KB will be hidden behind a "View entire message" link.`
		);
	}

	if (tableNestingDepth > 10) {
		warnings.push(
			`High table nesting depth (${tableNestingDepth}). Some email clients may have rendering issues with deeply nested tables. Consider simplifying the layout.`
		);
	}

	if (imageCount > 20) {
		warnings.push(
			`High image count (${imageCount}). Emails with many images may be slow to load or flagged by spam filters.`
		);
	}

	if (htmlSizeBytes > 80 * 1024 && !exceedsGmailClip) {
		const sizeKb = Math.round(htmlSizeBytes / 1024);
		warnings.push(
			`Email size (${sizeKb}KB) is approaching Gmail's 102KB clipping threshold. Consider optimizing content.`
		);
	}

	if (linkCount > 60) {
		warnings.push(
			`High link count (${linkCount}). Emails with excessive links may trigger spam filters.`
		);
	}

	if (!hasTextContent && imageCount > 0) {
		warnings.push(
			'Email appears to be image-only with minimal text content. This harms deliverability and accessibility.'
		);
	}

	if (imageCount > 0 && textToImageRatio < 50) {
		warnings.push(
			`Low text-to-image ratio (${textToImageRatio} chars per image). Consider adding more text content for better deliverability.`
		);
	}

	if (displayNoneCount > 3) {
		warnings.push(
			`Found ${displayNoneCount} display:none elements beyond preheader. Excessive hidden content can trigger spam filters.`
		);
	}

	// Check for potential issues
	if (html.includes('position:absolute') || html.includes('position: absolute')) {
		warnings.push(
			'Email contains position:absolute — this is stripped by Gmail and some other clients.'
		);
	}

	if (html.includes('<form') || html.includes('<input')) {
		warnings.push(
			'Email contains form elements — these are stripped by most email clients except Apple Mail/iOS.'
		);
	}

	if (html.includes('<video') || html.includes('<audio')) {
		warnings.push(
			'Email contains <video> or <audio> tags — only supported in Apple Mail/iOS. Use thumbnail + link pattern instead.'
		);
	}

	// Subject line analysis
	if (options?.subjectLine) {
		if (options.subjectLine.length > 70) {
			warnings.push(
				`Subject line is ${options.subjectLine.length} chars — may be truncated in Gmail (70 char limit).`
			);
		}
		if (
			options.subjectLine === options.subjectLine.toUpperCase() &&
			/[A-Z]/.test(options.subjectLine)
		) {
			warnings.push('Subject line is ALL CAPS — this can trigger spam filters.');
		}
	}

	// Gmail CSS size guard
	const styleMatches = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
	const styleContent = styleMatches
		? styleMatches.map((s) => s.replace(/<\/?style[^>]*>/gi, '')).join('')
		: '';
	const styleBlockSizeBytes = new TextEncoder().encode(styleContent).length;
	const exceedsGmailCssLimit = styleBlockSizeBytes > GMAIL_CSS_THRESHOLD;

	if (exceedsGmailCssLimit) {
		const sizeKb = Math.round(styleBlockSizeBytes / 1024);
		warnings.push(
			`CSS style block (${sizeKb}KB) exceeds Gmail's ~8KB limit. Gmail will strip the entire <style> block, breaking responsive layout and dark mode. Enable CSS inlining.`
		);
	} else if (styleBlockSizeBytes > GMAIL_CSS_WARNING_THRESHOLD) {
		const percent = Math.round((styleBlockSizeBytes / GMAIL_CSS_THRESHOLD) * 100);
		warnings.push(
			`CSS style block is at ${percent}% of Gmail's ~8KB limit. Consider reducing CSS to avoid Gmail stripping styles.`
		);
	}

	// Basic CSS syntax validation
	const cssValidationIssues: string[] = [];
	const openBraces = (styleContent.match(/{/g) || []).length;
	const closeBraces = (styleContent.match(/}/g) || []).length;
	if (openBraces !== closeBraces) {
		cssValidationIssues.push(
			`Unbalanced braces in CSS: ${openBraces} opening vs ${closeBraces} closing`
		);
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
