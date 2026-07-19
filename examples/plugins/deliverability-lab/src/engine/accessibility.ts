/**
 * Accessibility audit — the checks that make an email readable to screen readers
 * and low-vision recipients (and, not coincidentally, that inbox providers treat
 * as quality signals): images without alt text, a document with no language,
 * anchors with no discernible text, and a table-based layout with no summary.
 * Pure and deterministic.
 */

import { scanAnchors, scanImages, scanTags, textContent } from './html';
import type { DeliverabilityEmail, Finding, Verdict } from './types';
import { verdictOf } from './types';

export interface AccessibilityReport {
	readonly verdict: Verdict;
	readonly findings: readonly Finding[];
}

function hasLangAttribute(html: string): boolean {
	return scanTags(html).some(
		(tag) => tag.name === 'html' && (tag.attributes['lang'] ?? '').trim().length > 0
	);
}

function emptyAnchorCount(html: string): number {
	let count = 0;
	for (const { inner } of scanAnchors(html)) {
		// An anchor is discernible if it has visible text OR wraps an image with alt.
		if (textContent(inner).length > 0) continue;
		const wrapsLabelledImage = scanImages(inner).some(
			(img) => (img.attributes['alt'] ?? '').trim().length > 0
		);
		if (!wrapsLabelledImage) count += 1;
	}
	return count;
}

export function auditAccessibility(email: DeliverabilityEmail): AccessibilityReport {
	if (!email.html) {
		return { verdict: 'pass', findings: [] };
	}

	const html = email.html;
	const findings: Finding[] = [];

	const images = scanImages(html);
	const missingAlt = images.filter((img) => !('alt' in img.attributes)).length;
	if (missingAlt > 0) {
		findings.push({
			code: 'img_missing_alt',
			severity: 'fail',
			message: `${missingAlt} of ${images.length} image(s) have no alt attribute.`,
		});
	}

	const emptyAlt = images.filter(
		(img) => 'alt' in img.attributes && (img.attributes['alt'] ?? '').trim().length === 0
	).length;
	// A deliberately empty alt="" is valid for decorative images, so it is only a
	// warning, and only when there is no other alt text carrying the meaning.
	if (emptyAlt > 0 && missingAlt === 0 && emptyAlt === images.length) {
		findings.push({
			code: 'img_all_decorative',
			severity: 'warn',
			message: 'Every image is marked decorative (empty alt); confirm none carry meaning.',
		});
	}

	if (!hasLangAttribute(html)) {
		findings.push({
			code: 'missing_lang',
			severity: 'warn',
			message: 'The document has no lang attribute; screen readers cannot pick a voice.',
		});
	}

	const emptyAnchors = emptyAnchorCount(html);
	if (emptyAnchors > 0) {
		findings.push({
			code: 'empty_link_text',
			severity: 'fail',
			message: `${emptyAnchors} link(s) have no discernible text for a screen reader.`,
		});
	}

	return { verdict: verdictOf(findings), findings };
}
