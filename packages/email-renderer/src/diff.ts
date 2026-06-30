/**
 * Email render diff / change detection.
 * Compares two rendered email HTML strings and returns structural changes.
 * Useful for template versioning, A/B test verification, and regression detection.
 */

export interface EmailDiffChange {
	type: 'added' | 'removed' | 'modified';
	category: 'text' | 'style' | 'image' | 'link' | 'structure' | 'meta';
	description: string;
	/** Location context (e.g. element path or approximate line) */
	context?: string;
}

export interface EmailDiff {
	/** Whether the two emails are structurally identical */
	identical: boolean;
	/** List of detected changes */
	changes: EmailDiffChange[];
	/** Size difference in bytes (positive = B is larger) */
	sizeDelta: number;
	/** Summary statistics */
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
 * Extract structural elements from HTML for comparison.
 */
const extractElements = (html: string): Map<string, string[]> => {
	const elements = new Map<string, string[]>();

	// Extract text content blocks
	const textBlocks: string[] = [];
	const textRegex = /<(?:p|h[1-6]|td|th|div|span|a)[^>]*>([\s\S]*?)<\/(?:p|h[1-6]|td|th|div|span|a)>/gi;
	let match: RegExpExecArray | null;
	while ((match = textRegex.exec(html)) !== null) {
		const text = match[1]!.replace(/<[^>]+>/g, '').trim();
		if (text) textBlocks.push(text);
	}
	elements.set('text', textBlocks);

	// Extract images
	const images: string[] = [];
	const imgRegex = /<img[^>]*src="([^"]*)"[^>]*>/gi;
	while ((match = imgRegex.exec(html)) !== null) {
		images.push(match[1]!);
	}
	elements.set('images', images);

	// Extract links
	const links: string[] = [];
	const linkRegex = /<a[^>]*href="([^"]*)"[^>]*>/gi;
	while ((match = linkRegex.exec(html)) !== null) {
		links.push(match[1]!);
	}
	elements.set('links', links);

	// Extract inline styles
	const styles: string[] = [];
	const styleRegex = /style="([^"]*)"/gi;
	while ((match = styleRegex.exec(html)) !== null) {
		styles.push(match[1]!);
	}
	elements.set('styles', styles);

	return elements;
};

/**
 * Compare two rendered email HTML strings and return structural changes.
 */
export const diffEmails = (htmlA: string, htmlB: string): EmailDiff => {
	const encoder = new TextEncoder();
	const sizeA = encoder.encode(htmlA).length;
	const sizeB = encoder.encode(htmlB).length;
	const sizeDelta = sizeB - sizeA;

	const changes: EmailDiffChange[] = [];

	// Quick identity check
	if (htmlA === htmlB) {
		return {
			identical: true,
			changes: [],
			sizeDelta: 0,
			stats: { addedElements: 0, removedElements: 0, modifiedStyles: 0, textChanges: 0, linkChanges: 0, imageChanges: 0 },
		};
	}

	const elemA = extractElements(htmlA);
	const elemB = extractElements(htmlB);

	// Compare text content
	const textsA = elemA.get('text') || [];
	const textsB = elemB.get('text') || [];
	const textSetA = new Set(textsA);
	const textSetB = new Set(textsB);

	for (const t of textsB) {
		if (!textSetA.has(t)) {
			changes.push({ type: 'added', category: 'text', description: `Added text: "${t.substring(0, 80)}${t.length > 80 ? '...' : ''}"` });
		}
	}
	for (const t of textsA) {
		if (!textSetB.has(t)) {
			changes.push({ type: 'removed', category: 'text', description: `Removed text: "${t.substring(0, 80)}${t.length > 80 ? '...' : ''}"` });
		}
	}

	// Compare images
	const imgsA = elemA.get('images') || [];
	const imgsB = elemB.get('images') || [];
	const imgSetA = new Set(imgsA);
	const imgSetB = new Set(imgsB);

	for (const img of imgsB) {
		if (!imgSetA.has(img)) {
			changes.push({ type: 'added', category: 'image', description: `Added image: ${img}` });
		}
	}
	for (const img of imgsA) {
		if (!imgSetB.has(img)) {
			changes.push({ type: 'removed', category: 'image', description: `Removed image: ${img}` });
		}
	}

	// Compare links
	const linksA = elemA.get('links') || [];
	const linksB = elemB.get('links') || [];
	const linkSetA = new Set(linksA);
	const linkSetB = new Set(linksB);

	for (const link of linksB) {
		if (!linkSetA.has(link)) {
			changes.push({ type: 'added', category: 'link', description: `Added link: ${link}` });
		}
	}
	for (const link of linksA) {
		if (!linkSetB.has(link)) {
			changes.push({ type: 'removed', category: 'link', description: `Removed link: ${link}` });
		}
	}

	// Compare style count (structural indicator)
	const stylesA = elemA.get('styles') || [];
	const stylesB = elemB.get('styles') || [];
	const styleCountDiff = stylesB.length - stylesA.length;
	if (styleCountDiff !== 0) {
		changes.push({
			type: 'modified',
			category: 'style',
			description: `Style attribute count changed: ${stylesA.length} → ${stylesB.length} (${styleCountDiff > 0 ? '+' : ''}${styleCountDiff})`,
		});
	}

	// Check meta changes (title, preheader)
	const titleA = htmlA.match(/<title>([^<]*)<\/title>/)?.[1] || '';
	const titleB = htmlB.match(/<title>([^<]*)<\/title>/)?.[1] || '';
	if (titleA !== titleB) {
		changes.push({ type: 'modified', category: 'meta', description: `Title changed: "${titleA}" → "${titleB}"` });
	}

	// Size change
	if (Math.abs(sizeDelta) > 100) {
		changes.push({
			type: 'modified',
			category: 'structure',
			description: `Size changed by ${sizeDelta > 0 ? '+' : ''}${sizeDelta} bytes (${sizeA} → ${sizeB})`,
		});
	}

	// Compute stats
	const stats = {
		addedElements: changes.filter((c) => c.type === 'added').length,
		removedElements: changes.filter((c) => c.type === 'removed').length,
		modifiedStyles: changes.filter((c) => c.category === 'style').length,
		textChanges: changes.filter((c) => c.category === 'text').length,
		linkChanges: changes.filter((c) => c.category === 'link').length,
		imageChanges: changes.filter((c) => c.category === 'image').length,
	};

	return { identical: false, changes, sizeDelta, stats };
};
