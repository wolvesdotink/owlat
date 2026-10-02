/**
 * The image checks: images that do not load or are very heavy (from the
 * server's probes), images without alt text, images without a width.
 */
import { validateBlocks } from '@owlat/email-renderer';
import { findBlockIdContaining } from './blockLocator';
import type { PresendInput, PresendScan } from './input';
import { PRESEND_KEY as KEY, isProblem, probeReason, remoteUnavailable, verdict } from './remote';
import { LARGE_IMAGE_BYTES, type PresendCheck, type PresendItem } from './types';

const mb = (bytes: number) => (Math.round((bytes / (1024 * 1024)) * 10) / 10).toFixed(1);

function fileName(src: string): string {
	try {
		const path = new URL(src).pathname;
		return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)) || src;
	} catch {
		return src;
	}
}

export function imageLoadCheck(input: PresendInput, scan: PresendScan): PresendCheck {
	if (scan.images.length === 0) {
		return {
			id: 'imageLoad',
			category: 'images',
			status: 'pass',
			summary: `${KEY}.imageLoad.none`,
			items: [],
		};
	}
	const unavailable = remoteUnavailable('imageLoad', 'images', input.remote);
	if (unavailable || input.remote.status !== 'done') return unavailable!;

	const items: PresendItem[] = [];
	for (const result of input.remote.result.images) {
		const blockId = findBlockIdContaining(input.blocks, result.url);
		if (isProblem(result.status)) {
			items.push({ label: fileName(result.url), reason: probeReason(result), blockId });
		} else if (result.bytes !== undefined && result.bytes > LARGE_IMAGE_BYTES) {
			items.push({
				label: fileName(result.url),
				reason: {
					key: result.bytesAtLeast ? `${KEY}.reasons.imageAtLeast` : `${KEY}.reasons.imageLarge`,
					params: { size: mb(result.bytes), limit: mb(LARGE_IMAGE_BYTES) },
				},
				blockId,
			});
		}
	}
	return {
		id: 'imageLoad',
		category: 'images',
		status: verdict('pass', items),
		summary:
			items.length > 0
				? { key: `${KEY}.imageLoad.found`, params: { count: items.length } }
				: { key: `${KEY}.imageLoad.pass`, params: { count: input.remote.result.images.length } },
		items,
	};
}

const ALT_CODES = new Set(['IMAGE_NO_ALT', 'A11Y_CAROUSEL_IMAGE_NO_ALT']);

export function imageAltCheck(input: PresendInput, scan: PresendScan): PresendCheck {
	const items: PresendItem[] = [];
	const seen = new Set<string>();
	let issues: ReturnType<typeof validateBlocks>['issues'] = [];
	try {
		issues = validateBlocks(input.blocks, { accessibilityAudit: true, level: 'soft' }).issues;
	} catch {
		// Malformed stored Blocks: the HTML scan below still catches bare <img>s.
	}
	for (const issue of issues) {
		if (!ALT_CODES.has(issue.code) || !issue.blockId || seen.has(issue.blockId)) continue;
		seen.add(issue.blockId);
		items.push({
			label: `${KEY}.labels.${issue.blockType === 'carousel' ? 'carousel' : 'image'}`,
			reason: `${KEY}.reasons.missingAlt`,
			blockId: issue.blockId,
		});
	}
	// Raw HTML Blocks write their own <img> tags; one with no alt at all.
	for (const image of scan.html.images) {
		if (image.alt !== null || !image.src) continue;
		const blockId = findBlockIdContaining(input.blocks, image.src);
		if (blockId && seen.has(blockId)) continue;
		if (blockId) seen.add(blockId);
		items.push({ label: fileName(image.src), reason: `${KEY}.reasons.missingAlt`, blockId });
	}
	return {
		id: 'imageAlt',
		category: 'images',
		status: verdict('pass', items),
		summary:
			items.length > 0
				? { key: `${KEY}.imageAlt.found`, params: { count: items.length } }
				: `${KEY}.imageAlt.pass`,
		items,
	};
}

export function imageWidthCheck(input: PresendInput, scan: PresendScan): PresendCheck {
	const items = scan.html.images
		.filter((image) => image.src && !image.hasWidth)
		.map((image) => ({
			label: fileName(image.src),
			reason: `${KEY}.reasons.noWidth`,
			blockId: findBlockIdContaining(input.blocks, image.src),
		}));
	return {
		id: 'imageWidth',
		category: 'images',
		status: verdict('pass', items),
		summary:
			items.length > 0
				? { key: `${KEY}.imageWidth.found`, params: { count: items.length } }
				: `${KEY}.imageWidth.pass`,
		items,
	};
}
