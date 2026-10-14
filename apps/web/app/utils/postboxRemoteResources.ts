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
 * this pass cannot read with confidence (a CSS escape, an unreadable URL) is
 * treated as remote and as a tracker, so it fails closed.
 *
 * It runs last in the render pipeline, after the string transforms, so no
 * regex pass ever reads the DOM's re-serialized output.
 */

import {
	isEmbeddedResourceUrl,
	isTrackingResource,
	remoteResourceHost,
	stripRemoteImages,
	type RemoteResourceContext,
	type TrackerDetection,
} from '@owlat/shared/postboxTrackers';

/** What the reader currently lets the body load. */
export type PostboxImageConsent = 'blocked' | 'images' | 'everything';

export interface PostboxRemoteResourceResult {
	/** The body with every withheld reference removed or replaced. */
	html: string;
	/** The body references at least one remote resource (before gating). */
	hasRemoteResources: boolean;
	/** Tracker count and hosts over the same inventory (before gating). */
	detection: TrackerDetection;
}

/**
 * One URL a body would fetch. `url` is null when the reference could not be
 * read safely (a CSS escape can spell `url(` without the letters); such a
 * reference counts as remote and as a tracker.
 */
interface ResourceRef {
	url: string | null;
	remote: boolean;
	tracker: boolean;
}

function classify(url: string | null, context: RemoteResourceContext): ResourceRef {
	if (url === null) return { url, remote: true, tracker: true };
	if (isEmbeddedResourceUrl(url)) return { url, remote: false, tracker: false };
	return { url, remote: true, tracker: isTrackingResource(url, context) };
}

/**
 * Split an inline style into declarations on top-level `;`, honouring quotes,
 * parentheses and backslash escapes, so a `;` inside `url("…")` stays put.
 */
function splitDeclarations(style: string): string[] {
	const declarations: string[] = [];
	let depth = 0;
	let quote: string | null = null;
	let start = 0;
	for (let i = 0; i < style.length; i++) {
		const ch = style[i];
		if (ch === '\\') {
			i++;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === '(') depth++;
		else if (ch === ')') depth = Math.max(0, depth - 1);
		else if (ch === ';' && depth === 0) {
			declarations.push(style.slice(start, i));
			start = i + 1;
		}
	}
	declarations.push(style.slice(start));
	return declarations.filter((declaration) => declaration.trim() !== '');
}

/**
 * A top-level CSS function in one declaration (`url(…)`, `image-set(…)`,
 * `-webkit-cross-fade(…)`, anything) and every URL it could fetch.
 */
interface CssFunctionUnit {
	start: number;
	end: number;
	urls: string[];
}

function isCssIdentChar(ch: string): boolean {
	return /[\w-]/.test(ch) || ch.charCodeAt(0) >= 0x80;
}

/**
 * Tokenize one declaration in a single linear pass and collect, per
 * top-level function, every reference the browser could fetch. Rather than
 * know which functions take images (and miss a nesting such as
 * `cross-fade(image-set("…"))`), it fails closed: every `url(…)` token and
 * every quoted string inside a function, at any depth, counts, except a
 * string directly inside `type()`, which names a MIME type. A quoted string
 * outside every function (a `font-family` name) is never fetched. Comments
 * are skipped; an unterminated string, comment or function runs to the end.
 */
function cssFunctionUnits(value: string): CssFunctionUnit[] {
	const units: CssFunctionUnit[] = [];
	const stack: string[] = [];
	const length = value.length;
	// The top-level function being read, if any.
	const current: { unit: CssFunctionUnit | null } = { unit: null };
	const open = (name: string, at: number) => {
		if (stack.length === 0) current.unit = { start: at, end: length, urls: [] };
		stack.push(name);
	};
	const close = (end: number) => {
		stack.pop();
		if (stack.length === 0 && current.unit) {
			current.unit.end = end;
			units.push(current.unit);
			current.unit = null;
		}
	};
	let i = 0;
	while (i < length) {
		const ch = value[i]!;
		if (ch === '/' && value[i + 1] === '*') {
			const end = value.indexOf('*/', i + 2);
			i = end === -1 ? length : end + 2;
		} else if (ch === '"' || ch === "'") {
			const end = value.indexOf(ch, i + 1);
			const stop = end === -1 ? length : end;
			if (current.unit && stack[stack.length - 1] !== 'type') {
				current.unit.urls.push(value.slice(i + 1, stop).trim());
			}
			i = stop + 1;
		} else if (ch === '(') {
			open('', i);
			i++;
		} else if (ch === ')') {
			if (stack.length > 0) close(i + 1);
			i++;
		} else if (isCssIdentChar(ch)) {
			let j = i;
			while (j < length && isCssIdentChar(value[j]!)) j++;
			if (value[j] !== '(') {
				i = j;
				continue;
			}
			const name = value.slice(i, j).toLowerCase();
			open(name, i);
			i = j + 1;
			if (name !== 'url') continue;
			let k = i;
			while (k < length && /\s/.test(value[k]!)) k++;
			if (value[k] === '"' || value[k] === "'") continue;
			// An unquoted url token runs to the next `)`, quotes and all.
			const end = value.indexOf(')', k);
			const stop = end === -1 ? length : end;
			current.unit?.urls.push(value.slice(k, stop).trim());
			close(stop + 1);
			i = stop + 1;
		} else {
			i++;
		}
	}
	if (current.unit) units.push(current.unit);
	return units;
}

/**
 * Gate one CSS declaration. Each top-level function that could fetch a
 * withheld URL is rewritten to `none`, so `background:#000 url(…)` keeps its colour (and
 * the newsletter its contrast) while the image layer goes. Returns the refs
 * it found and the declaration to keep, or null to drop it.
 */
function gateDeclaration(
	declaration: string,
	classifyUrl: (url: string | null) => ResourceRef,
	withheld: (ref: ResourceRef) => boolean
): { refs: ResourceRef[]; kept: string | null } {
	// `\75 rl(…)` is still `url(…)`, and an escaped host defeats the tracker
	// match; no legitimate mail needs either, so the whole value is opaque.
	if (declaration.includes('\\')) {
		const ref = classifyUrl(null);
		return { refs: [ref], kept: withheld(ref) ? null : declaration };
	}
	const refs: ResourceRef[] = [];
	let kept = '';
	let last = 0;
	for (const fn of cssFunctionUnits(declaration)) {
		const fnRefs = fn.urls.map(classifyUrl);
		refs.push(...fnRefs);
		if (!fnRefs.some(withheld)) continue;
		kept += `${declaration.slice(last, fn.start)}none`;
		last = fn.end;
	}
	kept += declaration.slice(last);
	return { refs, kept };
}

/**
 * The `srcset` candidates: each one's URL and its full text (URL plus
 * descriptors). A candidate's URL runs to the next whitespace (so a `data:`
 * URL keeps its comma); trailing commas end it.
 */
function srcsetCandidates(srcset: string): Array<{ url: string; text: string }> {
	const candidates: Array<{ url: string; text: string }> = [];
	let i = 0;
	while (i < srcset.length) {
		while (i < srcset.length && /[\s,]/.test(srcset[i]!)) i++;
		if (i >= srcset.length) break;
		const start = i;
		let end = i;
		while (end < srcset.length && !/\s/.test(srcset[end]!)) end++;
		let url = srcset.slice(i, end);
		i = end;
		if (url.endsWith(',')) {
			// A backward scan: `/,+$/` rescans every inner run of commas.
			let stop = url.length;
			while (stop > 0 && url[stop - 1] === ',') stop--;
			url = url.slice(0, stop);
			if (url) candidates.push({ url, text: url });
			continue;
		}
		// The descriptors run up to the comma that ends this candidate.
		let depth = 0;
		while (i < srcset.length && !(srcset[i] === ',' && depth === 0)) {
			if (srcset[i] === '(') depth++;
			else if (srcset[i] === ')') depth = Math.max(0, depth - 1);
			i++;
		}
		if (url) candidates.push({ url, text: srcset.slice(start, i).trim() });
	}
	return candidates;
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
 * a withheld image.
 */
export function applyPostboxImageConsent(
	html: string,
	consent: PostboxImageConsent,
	blockedLabel: string
): PostboxRemoteResourceResult {
	try {
		return gateResources(html, consent, blockedLabel);
	} catch {
		// Fail closed: with no inventory, keep no remote <img>. The iframe CSP
		// still refuses every other remote load while images are blocked.
		const stripped = stripRemoteImages(html);
		return {
			html: consent === 'everything' ? html : stripped.html,
			hasRemoteResources: stripped.strippedRemoteImages > 0,
			detection: { pixelCount: 0, trackerHosts: [] },
		};
	}
}

function gateResources(
	html: string,
	consent: PostboxImageConsent,
	blockedLabel: string
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
		const style = el.getAttribute('style') ?? '';
		const context: RemoteResourceContext = {
			width: el.getAttribute('width'),
			height: el.getAttribute('height'),
			style,
		};
		const refs: ResourceRef[] = [];

		// Inline style: rewrite each image layer that would fetch a withheld URL.
		if (style) {
			const classifyUrl = (url: string | null) => classify(url, context);
			const declarations = splitDeclarations(style).map((declaration) => {
				const original = declaration.trim();
				return { original, ...gateDeclaration(original, classifyUrl, withheld) };
			});
			for (const d of declarations) refs.push(...d.refs);
			if (declarations.some((d) => d.kept !== d.original)) {
				const kept = declarations.flatMap((d) => (d.kept === null ? [] : [d.kept]));
				if (kept.length === 0) el.removeAttribute('style');
				else el.setAttribute('style', kept.join(';'));
			}
		}

		// Legacy `<td background="…">`; the sanitizer drops it today, but a
		// later allowlist change must not quietly reopen it.
		const background = el.getAttribute('background');
		if (background !== null) {
			const ref = classify(background, context);
			refs.push(ref);
			if (withheld(ref)) el.removeAttribute('background');
		}

		let replacement: 'none' | 'placeholder' | 'remove' = 'none';
		let blockedUrl = '';
		if (el.tagName === 'IMG') {
			const src = el.getAttribute('src');
			const srcRef = src === null ? null : classify(src, context);
			const candidates = srcsetCandidates(el.getAttribute('srcset') ?? '').map((candidate) => ({
				...candidate,
				ref: classify(candidate.url, context),
			}));
			if (srcRef) refs.push(srcRef);
			refs.push(...candidates.map((candidate) => candidate.ref));

			// Withhold candidate by candidate: one tracker in a srcset must not
			// take the approved sources (and their descriptors) with it.
			const keptCandidates = candidates.filter((candidate) => !withheld(candidate.ref));
			const withheldCandidate = candidates.find((candidate) => withheld(candidate.ref));
			if (withheldCandidate) {
				if (keptCandidates.length > 0) {
					el.setAttribute('srcset', keptCandidates.map((candidate) => candidate.text).join(', '));
				} else {
					el.removeAttribute('srcset');
				}
			}
			const srcWithheld = srcRef !== null && withheld(srcRef);
			if (srcWithheld) el.removeAttribute('src');
			// The image goes only when something was withheld and no usable
			// source is left to show.
			const hasSource = (srcRef !== null && !srcWithheld) || keptCandidates.length > 0;
			if ((srcWithheld || withheldCandidate) && !hasSource) {
				replacement = consent === 'blocked' ? 'placeholder' : 'remove';
				blockedUrl = (srcWithheld ? src : withheldCandidate?.url) ?? '';
			}
		}

		if (refs.some((ref) => ref.remote)) hasRemoteResources = true;
		const trackers = refs.filter((ref) => ref.tracker);
		if (trackers.length > 0) {
			pixelCount += 1;
			for (const ref of trackers) {
				const host = remoteResourceHost(ref.url);
				if (host) trackerHosts.add(host);
			}
		}

		if (replacement === 'placeholder')
			el.replaceWith(blockedPlaceholder(doc, blockedUrl, blockedLabel));
		else if (replacement === 'remove') el.remove();
	}

	return {
		html: template.innerHTML,
		hasRemoteResources,
		detection: { pixelCount, trackerHosts: [...trackerHosts].sort() },
	};
}
