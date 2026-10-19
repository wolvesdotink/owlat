/**
 * Remote-resource consent for a rendered Postbox message body.
 *
 * A sanitized body can make the iframe fetch from the network in more ways
 * than `<img src>`: every `srcset` candidate (also on an image whose own `src`
 * is an inline `data:` URL), a CSS `background`/`background-image` URL, an
 * `image-set()`, a legacy `background` attribute. Gating only `src` let the
 * others load with images blocked, and the tracker count never saw them.
 *
 * This module parses the body once (an inert `<template>`, so nothing loads)
 * and builds one inventory of every resource reference. That inventory drives
 * all of it: which references are withheld under the current consent, the
 * tracker count and hosts for the banner and badge, and whether the body has
 * anything to ask about at all.
 *
 *   - `blocked`    → every reference that is not `data:`/`cid:` is withheld.
 *   - `images`     → only references classified as trackers are withheld.
 *   - `everything` → nothing is withheld.
 *
 * The iframe's CSP is the load-bearing half for `blocked` (it admits no remote
 * image at all until the user consents); this pass keeps the markup honest so
 * the banner, the counts and the "Show images" state agree with it. Anything
 * this pass cannot read with confidence (a URL that does not parse) is treated
 * as remote and as a tracker, and an element it fails to inventory loses all
 * of its CSS and srcset resources, so it fails closed. If the body cannot be
 * inventoried at all, `noRemote` tells the reader to keep the no-network
 * policy whatever the consent.
 *
 * It runs last in the render pipeline, after the string transforms, so no
 * regex pass ever reads the DOM's re-serialized output.
 */

import {
	elementTrackingHints,
	isEmbeddedResourceUrl,
	isTrackingResource,
	remoteResourceHost,
	stripRemoteImages,
	type TrackerDetection,
	type TrackingHints,
} from '@owlat/shared/postboxTrackers';
import {
	cssFunctionUnits,
	splitStyleDeclarations,
	srcsetCandidates,
} from '~/utils/postboxResourceParsers';

/** What the reader currently lets the body load. */
export type PostboxImageConsent = 'blocked' | 'images' | 'everything';

export interface PostboxRemoteResourceResult {
	/** The body with every withheld reference removed or replaced. */
	html: string;
	/** The body references at least one remote resource (before gating). */
	hasRemoteResources: boolean;
	/** Tracker count and hosts over the same inventory (before gating). */
	detection: TrackerDetection;
	/**
	 * The body could not be inventoried: render it with no remote loads at
	 * all, even after consent, rather than trust markup nobody checked.
	 */
	noRemote: boolean;
}

/**
 * One URL a body would fetch. `url` is null for an element the inventory
 * failed on; such a reference counts as remote and as a tracker.
 */
interface ResourceRef {
	url: string | null;
	remote: boolean;
	tracker: boolean;
}

const UNREADABLE_REF: ResourceRef = { url: null, remote: true, tracker: true };

function classify(url: string, hints: TrackingHints): ResourceRef {
	if (isEmbeddedResourceUrl(url)) return { url, remote: false, tracker: false };
	return { url, remote: true, tracker: isTrackingResource(url, hints) };
}

/**
 * Gate one CSS declaration. Each top-level function that could fetch a
 * withheld URL is rewritten to `none`, so `background:#000 url(…)` keeps its
 * colour (and the newsletter its contrast) while the image layer goes. Every
 * reference found is appended to `refs`; returns the declaration to keep.
 */
function gateDeclaration(
	declaration: string,
	classifyUrl: (url: string) => ResourceRef,
	withheld: (ref: ResourceRef) => boolean,
	refs: ResourceRef[]
): string {
	let kept = '';
	let last = 0;
	for (const fn of cssFunctionUnits(declaration)) {
		let withholdFn = false;
		for (const url of fn.urls) {
			const ref = classifyUrl(url);
			refs.push(ref);
			if (withheld(ref)) withholdFn = true;
		}
		if (!withholdFn) continue;
		kept += `${declaration.slice(last, fn.start)}none`;
		last = fn.end;
	}
	return kept + declaration.slice(last);
}

function blockedPlaceholder(doc: Document, url: string, label: string): HTMLElement {
	const span = doc.createElement('span');
	span.setAttribute('data-blocked-img', url);
	span.setAttribute(
		'style',
		'display:inline-block;padding:4px 8px;background:#eee;color:#666;font-size:11px;border-radius:3px;'
	);
	span.textContent = label;
	return span;
}

/**
 * Inventory the body's remote resources and withhold the ones the current
 * consent does not cover. `blockedLabel` is the text of the stand-in shown for
 * a withheld image; null drops the image without a stand-in (a quote, whose
 * stand-in would otherwise go out in the reply).
 */
export function applyPostboxImageConsent(
	html: string,
	consent: PostboxImageConsent,
	blockedLabel: string | null
): PostboxRemoteResourceResult {
	try {
		return gateResources(html, consent, blockedLabel);
	} catch {
		// Fail closed: with no inventory, keep no remote <img> and tell the
		// reader to render with no network at all, whatever the consent.
		const stripped = stripRemoteImages(html);
		return {
			html: consent === 'everything' ? html : stripped.html,
			hasRemoteResources: true,
			detection: { pixelCount: 0, trackerHosts: [] },
			noRemote: consent !== 'everything',
		};
	}
}

interface ElementOutcome {
	refs: ResourceRef[];
	replacement: 'none' | 'placeholder' | 'remove';
	blockedUrl: string;
}

/** Inventory one element and withhold what the consent does not cover. */
function gateElement(
	el: Element,
	consent: PostboxImageConsent,
	withheld: (ref: ResourceRef) => boolean
): ElementOutcome {
	const style = el.getAttribute('style') ?? '';
	// Read once per element: every reference on it shares these hints.
	const hints = elementTrackingHints({
		width: el.getAttribute('width'),
		height: el.getAttribute('height'),
		style,
	});
	const classifyUrl = (url: string) => classify(url, hints);
	const refs: ResourceRef[] = [];
	const outcome: ElementOutcome = { refs, replacement: 'none', blockedUrl: '' };

	// Inline style: rewrite each image layer that would fetch a withheld URL.
	if (style) {
		let changed = false;
		const kept: string[] = [];
		for (const declaration of splitStyleDeclarations(style)) {
			const original = declaration.trim();
			const gated = gateDeclaration(original, classifyUrl, withheld, refs);
			if (gated !== original) changed = true;
			kept.push(gated);
		}
		if (changed) el.setAttribute('style', kept.join(';'));
	}

	// Legacy `<td background="…">`; the sanitizer drops it today, but a
	// later allowlist change must not quietly reopen it.
	const background = el.getAttribute('background');
	if (background !== null) {
		const ref = classifyUrl(background);
		refs.push(ref);
		if (withheld(ref)) el.removeAttribute('background');
	}

	if (el.tagName !== 'IMG') return outcome;

	const src = el.getAttribute('src');
	const srcRef = src === null ? null : classifyUrl(src);
	if (srcRef) refs.push(srcRef);
	// Withhold candidate by candidate: one tracker in a srcset must not take
	// the approved sources (and their descriptors) with it.
	const keptCandidates: string[] = [];
	let withheldCandidate: string | null = null;
	for (const candidate of srcsetCandidates(el.getAttribute('srcset') ?? '')) {
		const ref = classifyUrl(candidate.url);
		refs.push(ref);
		if (!withheld(ref)) keptCandidates.push(candidate.text);
		else withheldCandidate ??= candidate.url;
	}
	if (withheldCandidate !== null) {
		if (keptCandidates.length > 0) el.setAttribute('srcset', keptCandidates.join(', '));
		else el.removeAttribute('srcset');
	}
	const srcWithheld = srcRef !== null && withheld(srcRef);
	if (srcWithheld) el.removeAttribute('src');
	// The image goes only when something was withheld and no usable source is
	// left to show.
	const hasSource = (srcRef !== null && !srcWithheld) || keptCandidates.length > 0;
	if ((srcWithheld || withheldCandidate !== null) && !hasSource) {
		outcome.replacement = consent === 'blocked' ? 'placeholder' : 'remove';
		outcome.blockedUrl = (srcWithheld ? src : withheldCandidate) ?? '';
	}
	return outcome;
}

/**
 * The inventory failed on this element. Unless the user asked for
 * everything, withhold every CSS, srcset and remote src resource it carries
 * rather than let its unchecked markup through, and count it as a tracker.
 */
function failElementClosed(el: Element, consent: PostboxImageConsent): ElementOutcome {
	const outcome: ElementOutcome = { refs: [UNREADABLE_REF], replacement: 'none', blockedUrl: '' };
	if (consent === 'everything') return outcome;
	el.removeAttribute('style');
	el.removeAttribute('srcset');
	el.removeAttribute('background');
	if (el.tagName === 'IMG') {
		const src = el.getAttribute('src');
		if (src === null || !isEmbeddedResourceUrl(src)) {
			outcome.replacement = consent === 'blocked' ? 'placeholder' : 'remove';
			outcome.blockedUrl = src ?? '';
		}
	}
	return outcome;
}

function gateResources(
	html: string,
	consent: PostboxImageConsent,
	blockedLabel: string | null
): PostboxRemoteResourceResult {
	const template = document.createElement('template');
	template.innerHTML = html;
	const doc = template.ownerDocument;
	const withheld = (ref: ResourceRef) =>
		ref.remote && (consent === 'blocked' || (consent === 'images' && ref.tracker));

	let hasRemoteResources = false;
	let pixelCount = 0;
	const trackerHosts = new Set<string>();

	for (const el of Array.from(template.content.querySelectorAll('*'))) {
		let outcome: ElementOutcome;
		try {
			outcome = gateElement(el, consent, withheld);
		} catch {
			outcome = failElementClosed(el, consent);
		}

		let hasTracker = false;
		for (const ref of outcome.refs) {
			if (ref.remote) hasRemoteResources = true;
			if (!ref.tracker) continue;
			hasTracker = true;
			const host = remoteResourceHost(ref.url);
			if (host) trackerHosts.add(host);
		}
		if (hasTracker) pixelCount += 1;

		if (outcome.replacement === 'placeholder' && blockedLabel !== null) {
			el.replaceWith(blockedPlaceholder(doc, outcome.blockedUrl, blockedLabel));
		} else if (outcome.replacement !== 'none') {
			el.remove();
		}
	}

	return {
		html: template.innerHTML,
		hasRemoteResources,
		detection: { pixelCount, trackerHosts: [...trackerHosts].sort() },
		noRemote: false,
	};
}
