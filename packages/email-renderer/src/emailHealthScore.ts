/**
 * Email health score: one 0-100 rating per dimension (compatibility,
 * accessibility, deliverability, Outlook support) plus a weighted overall,
 * with recommendations for what pulled each one down.
 */

import type {
	EditorBlock,
	ClientSupport,
	CommonBlockProperties,
	ValidationIssue,
} from '@owlat/shared';
import { analyzeEmail, type EmailAnalysis } from './analyzer';
import { scoreBlockCompatibility } from './compatibility';
import { validateBlocks } from './validator';
import type { EmailHealthScore, EmailHealthRecommendation, RenderOptions } from './types';

/**
 * Work a caller already did for the same blocks + html, handed to
 * {@link getEmailHealthScore} so it is not repeated. Each field is recomputed
 * when absent.
 */
interface EmailHealthScoreInputs {
	/** `analyzeEmail(html)` (no options) for the exact html being scored. */
	analysis?: EmailAnalysis;
	/**
	 * Issues from `validateBlocks(blocks, { accessibilityAudit: true })` at any
	 * level except 'skip'. The level only decides `valid` (and whether 'strict'
	 * throws); no validator reads it, so the issue list is the same one this
	 * function would collect with `level: 'soft'`.
	 */
	validationIssues?: ValidationIssue[];
}

/** Calculate a comprehensive email health score across multiple dimensions */
export const getEmailHealthScore = (
	blocks: EditorBlock[],
	html: string,
	_options?: RenderOptions,
	inputs?: EmailHealthScoreInputs
): EmailHealthScore => {
	const recommendations: EmailHealthRecommendation[] = [];

	// Each Block's compatibility is scored once and shared by the compatibility
	// and Outlook dimensions below.
	const blockScores = blocks.map((block) =>
		scoreBlockCompatibility(
			block.type,
			block.content as CommonBlockProperties as unknown as Record<string, unknown>
		)
	);

	// --- 1. Compatibility score ---
	let compatTotal = 0;
	let compatCount = 0;
	for (const [i, block] of blocks.entries()) {
		const score = blockScores[i]!;
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
	const validationIssues =
		inputs?.validationIssues ??
		validateBlocks(blocks, { accessibilityAudit: true, level: 'soft' }).issues;
	// IMAGE_NO_ALT predates the A11Y_ code prefix but is an accessibility defect,
	// so it counts here too — and clears once the image is marked decorative.
	const a11yIssues = validationIssues.filter(
		(i) => i.code.startsWith('A11Y_') || i.code === 'IMAGE_NO_ALT'
	);
	const a11yErrors = a11yIssues.filter((i) => i.severity === 'error').length;
	const a11yWarnings = a11yIssues.filter((i) => i.severity === 'warning').length;
	const accessibility = Math.max(0, 100 - a11yErrors * 20 - a11yWarnings * 10);
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
	const analysis = inputs?.analysis ?? analyzeEmail(html);
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
	const outlookClients: (keyof ClientSupport)[] = [
		'outlookDesktop',
		'outlook365',
		'outlookNew',
		'outlookMac',
	];
	let outlookTotal = 0;
	let outlookCount = 0;
	for (const score of blockScores) {
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
		compatibility * 0.35 + accessibility * 0.2 + deliverability * 0.3 + outlookSupport * 0.15
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
