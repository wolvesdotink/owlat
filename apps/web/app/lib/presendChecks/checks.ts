/**
 * The pre-send checks, assembled: everything the browser can judge from the
 * rendered HTML and the Blocks, plus what the server round trip found (links,
 * images, the MTA's content screening). Pure; `usePresendChecks` feeds it.
 *
 * Every new check reports `warning` at most. The only `blocking` item is the
 * refusal the send already makes today (`sending`), shown here so the list
 * says everything in one place.
 */
import type { LocalizedText } from '~/utils/localizedText';
import { findBlockIdContaining } from './blockLocator';
import { darkContrastItems, lightContrastItems } from './contrast';
import { hasUnsubscribeLink, planImages, planLinks } from './links';
import { imageAltCheck, imageLoadCheck, imageWidthCheck } from './imageChecks';
import type { PresendInput, PresendScan } from './input';
import { hasPostalAddress } from './postalAddress';
import { PRESEND_KEY as KEY, isProblem, probeReason, remoteUnavailable, verdict } from './remote';
import { scanHtml, type ScannedHtml } from './scanHtml';
import {
	GMAIL_CLIP_BYTES,
	GMAIL_CLIP_WARNING_BYTES,
	SUBJECT_MAX_CHARS,
	type PresendCheck,
	type PresendItem,
} from './types';

export function scanForPresend(html: string): PresendScan {
	const scanned = scanHtml(html);
	return {
		html: scanned,
		links: planLinks(scanned.links),
		images: planImages(scanned.images.map((image) => image.src)),
	};
}

// What the send path adds to the stored HTML (`delivery/sendComposition/
// transform.ts`): the footer and the view-in-browser line with their signed
// URLs, the tracking pixel, and every web link rewritten to a signed tracking
// redirect that carries the target base64url-encoded. Estimated from the markup
// that transform writes, rounded up.
const FOOTER_BYTES = 1200;
const VIEW_IN_BROWSER_BYTES = 450;
const PIXEL_BYTES = 250;
const TRACKED_LINK_OVERHEAD_BYTES = 130;

/** The stored HTML's size plus what the send path adds to every copy. */
export function estimateDeliveredBytes(
	scanned: ScannedHtml,
	audienceKind: 'topic' | 'segment' | undefined
): number {
	let bytes = scanned.bytes + VIEW_IN_BROWSER_BYTES + PIXEL_BYTES;
	if (audienceKind !== 'segment') bytes += FOOTER_BYTES;
	for (const { href } of scanned.links) {
		if (!/^https?:\/\//i.test(href.trim())) continue;
		bytes += TRACKED_LINK_OVERHEAD_BYTES + Math.ceil(href.length / 3);
	}
	return bytes;
}

const kb = (bytes: number) => Math.round(bytes / 1024);

function sendingCheck(input: PresendInput): PresendCheck | null {
	if (input.blockedReason === undefined) return null;
	return input.blockedReason
		? {
				id: 'sending',
				category: 'sending',
				status: 'blocking',
				summary: input.blockedReason,
				items: [],
			}
		: {
				id: 'sending',
				category: 'sending',
				status: 'pass',
				summary: `${KEY}.sending.pass`,
				items: [],
			};
}

function sizeCheck(input: PresendInput, scan: PresendScan): PresendCheck {
	const bytes = estimateDeliveredBytes(scan.html, input.audienceKind);
	const params = { size: kb(bytes), limit: kb(GMAIL_CLIP_BYTES) };
	const summary: LocalizedText =
		bytes > GMAIL_CLIP_BYTES
			? { key: `${KEY}.size.clipped`, params }
			: bytes >= GMAIL_CLIP_WARNING_BYTES
				? { key: `${KEY}.size.near`, params }
				: { key: `${KEY}.size.pass`, params };
	return {
		id: 'size',
		category: 'size',
		status: bytes >= GMAIL_CLIP_WARNING_BYTES ? 'warning' : 'pass',
		summary,
		items: [],
	};
}

function linksCheck(input: PresendInput, scan: PresendScan): PresendCheck {
	const { probes, notProbed } = scan.links;
	if (probes.size === 0) {
		return {
			id: 'links',
			category: 'links',
			status: 'pass',
			summary: notProbed > 0 ? `${KEY}.links.personalizedOnly` : `${KEY}.links.none`,
			items: [],
		};
	}
	const unavailable = remoteUnavailable('links', 'links', input.remote);
	if (unavailable || input.remote.status !== 'done') return unavailable!;

	const results = input.remote.result.links;
	const items = results
		.filter((result) => isProblem(result.status))
		.map((result) => {
			const href = probes.get(result.url) ?? result.url;
			return {
				label: href,
				reason: probeReason(result),
				blockId: findBlockIdContaining(input.blocks, href),
			};
		});
	const unverified =
		notProbed + results.filter((r) => r.status === 'unverified' || r.status === 'skipped').length;
	return {
		id: 'links',
		category: 'links',
		status: verdict('pass', items),
		summary:
			items.length > 0
				? { key: `${KEY}.links.broken`, params: { count: items.length } }
				: { key: `${KEY}.links.pass`, params: { count: results.length } },
		...(unverified > 0
			? { note: { key: `${KEY}.links.notChecked`, params: { count: unverified } } }
			: {}),
		items,
	};
}

function linkSyntaxCheck(input: PresendInput, scan: PresendScan): PresendCheck {
	const items = scan.links.malformed.map(({ href, reason }) => ({
		label: href || '—',
		reason,
		blockId: href ? findBlockIdContaining(input.blocks, href) : undefined,
	}));
	return {
		id: 'linkSyntax',
		category: 'links',
		status: verdict('pass', items),
		summary:
			items.length > 0
				? { key: `${KEY}.linkSyntax.found`, params: { count: items.length } }
				: `${KEY}.linkSyntax.pass`,
		items,
	};
}

function contrastCheck(id: 'contrastLight' | 'contrastDark', items: PresendItem[]): PresendCheck {
	return {
		id,
		category: 'accessibility',
		status: verdict('pass', items),
		summary:
			items.length > 0
				? { key: `${KEY}.${id}.found`, params: { count: items.length } }
				: `${KEY}.${id}.pass`,
		items,
	};
}

function screeningCheck(input: PresendInput, scan: PresendScan): PresendCheck {
	const unavailable = remoteUnavailable('screening', 'content', input.remote);
	if (unavailable || input.remote.status !== 'done') return unavailable!;
	const base: Pick<PresendCheck, 'id' | 'category' | 'items'> = {
		id: 'screening',
		category: 'content',
		items: [],
	};
	const screening = input.remote.result.screening;
	if (screening.status === 'too_large') {
		return { ...base, status: 'skipped', summary: `${KEY}.screening.tooLarge` };
	}
	if (screening.status !== 'ready') {
		return { ...base, status: 'skipped', summary: `${KEY}.screening.unavailable` };
	}
	const { verdict: result } = screening;
	if (!result.enabled) return { ...base, status: 'skipped', summary: `${KEY}.screening.disabled` };
	const spam = result.spam
		? { score: result.spam.score.toFixed(1), threshold: result.spam.threshold }
		: null;
	if (result.verdict === 'accept') {
		return {
			...base,
			status: 'pass',
			summary: spam
				? { key: `${KEY}.screening.passScored`, params: spam }
				: `${KEY}.screening.pass`,
		};
	}
	const items: PresendItem[] = [];
	if (result.reason === 'blocked_url' && result.blockedPattern) {
		const pattern = result.blockedPattern.toLowerCase();
		const link = scan.html.links.find((l) => l.href.toLowerCase().includes(pattern));
		if (link) {
			items.push({
				label: link.href,
				reason: { key: `${KEY}.reasons.blockedUrl`, params: { pattern: result.blockedPattern } },
				blockId: findBlockIdContaining(input.blocks, link.href),
			});
		}
	}
	const summary: LocalizedText =
		result.reason === 'content_too_large'
			? { key: `${KEY}.screening.rejectSize`, params: { limit: result.sizeLimitKb } }
			: result.reason === 'blocked_url'
				? {
						key: `${KEY}.screening.rejectBlockedUrl`,
						params: { pattern: result.blockedPattern ?? '' },
					}
				: result.reason === 'spam_score' && spam
					? { key: `${KEY}.screening.rejectSpam`, params: spam }
					: result.reason === 'empty_body'
						? `${KEY}.screening.rejectEmpty`
						: `${KEY}.screening.reject`;
	return { ...base, status: 'warning', summary, items };
}

function subjectCheck(input: PresendInput): PresendCheck {
	const subject = input.subject.trim();
	const items: PresendItem[] = [];
	if (!subject) items.push({ label: '—', reason: `${KEY}.reasons.subjectEmpty` });
	if (subject.length > SUBJECT_MAX_CHARS) {
		items.push({
			label: subject,
			reason: {
				key: `${KEY}.reasons.subjectLong`,
				params: { count: subject.length, max: SUBJECT_MAX_CHARS },
			},
		});
	}
	if (subject === subject.toUpperCase() && /\p{Lu}/u.test(subject) && subject.length > 3) {
		items.push({ label: subject, reason: `${KEY}.reasons.subjectAllCaps` });
	}
	return {
		id: 'subject',
		category: 'content',
		status: verdict('pass', items),
		summary: items.length > 0 ? `${KEY}.subject.found` : `${KEY}.subject.pass`,
		items,
	};
}

function unsubscribeCheck(input: PresendInput, scan: PresendScan): PresendCheck {
	const own = hasUnsubscribeLink(scan.html.links);
	const base: Pick<PresendCheck, 'id' | 'category' | 'items'> = {
		id: 'unsubscribe',
		category: 'compliance',
		items: [],
	};
	if (input.audienceKind === 'segment') {
		return own
			? { ...base, status: 'pass', summary: `${KEY}.unsubscribe.ownLink` }
			: { ...base, status: 'warning', summary: `${KEY}.unsubscribe.segmentMissing` };
	}
	return {
		...base,
		status: 'pass',
		summary: `${KEY}.unsubscribe.footer`,
		...(input.audienceKind === undefined && !own ? { note: `${KEY}.unsubscribe.segmentNote` } : {}),
	};
}

function postalAddressCheck(scan: PresendScan): PresendCheck {
	const found = hasPostalAddress(scan.html.text);
	return {
		id: 'postalAddress',
		category: 'compliance',
		status: found ? 'pass' : 'warning',
		summary: found ? `${KEY}.postalAddress.pass` : `${KEY}.postalAddress.missing`,
		items: [],
	};
}

/** Every check for one rendered email, in the order the panel lists them. */
export function buildPresendChecks(input: PresendInput, scan: PresendScan): PresendCheck[] {
	const sending = sendingCheck(input);
	return [
		...(sending ? [sending] : []),
		sizeCheck(input, scan),
		linksCheck(input, scan),
		linkSyntaxCheck(input, scan),
		imageLoadCheck(input, scan),
		imageAltCheck(input, scan),
		imageWidthCheck(input, scan),
		contrastCheck('contrastLight', lightContrastItems(input.blocks, input.theme)),
		contrastCheck('contrastDark', darkContrastItems(input.blocks, input.theme)),
		screeningCheck(input, scan),
		subjectCheck(input),
		unsubscribeCheck(input, scan),
		postalAddressCheck(scan),
	];
}

export interface PresendSummary {
	warnings: number;
	blocking: number;
	pending: number;
	/** Changes whenever the set of warnings does, so an acknowledgement goes stale with it. */
	signature: string;
}

export function summarizePresend(checks: readonly PresendCheck[]): PresendSummary {
	const warnings = checks.filter((check) => check.status === 'warning');
	return {
		warnings: warnings.length,
		blocking: checks.filter((check) => check.status === 'blocking').length,
		pending: checks.filter((check) => check.status === 'pending').length,
		signature: warnings
			.map(
				(check) => `${check.id}:${check.items.map((item) => JSON.stringify(item.label)).join(',')}`
			)
			.join('|'),
	};
}
