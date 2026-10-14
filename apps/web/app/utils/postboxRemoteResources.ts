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

const CSS_URL_RE = /\b(?:url|src)\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))/gi;
const CSS_STRING_RE = /"([^"]*)"|'([^']*)'/g;
// The start of every CSS function that can fetch an image. `image-set()` and
// `cross-fade()` are taken whole, with the url()s inside them.
const CSS_IMAGE_FUNCTION_RE = /(?:-webkit-)?(?:image-set|cross-fade)\(|\b(?:url|src)\(/gi;
// `type("image/png")` inside an image-set names a MIME type, not a URL.
const CSS_TYPE_RE = /\btype\(\s*(?:"[^"]*"|'[^']*')\s*\)/gi;

/** Index just past the `)` closing the function whose `(` is at `open`, honouring quotes. */
function closingParen(text: string, open: number): number {
	let depth = 0;
	let quote: string | null = null;
	for (let i = open; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) quote = null;
		} else if (ch === '"' || ch === "'") quote = ch;
		else if (ch === '(') depth++;
		else if (ch === ')' && --depth === 0) return i + 1;
	}
	// Unterminated: the function runs to the end of the declaration.
	return text.length;
}

/** Every URL one image function (`url()`, `image-set()`, …) can fetch. */
function imageFunctionUrls(fn: string): string[] {
	const urls: string[] = [];
	for (const match of fn.matchAll(CSS_URL_RE)) {
		urls.push((match[1] ?? match[2] ?? match[3] ?? '').trim());
	}
	// `image-set("a.png" 1x)` fetches its plain strings too.
	if (/^(?:-webkit-)?image-set\(/i.test(fn)) {
		for (const match of fn.replace(CSS_TYPE_RE, '').matchAll(CSS_STRING_RE)) {
			urls.push((match[1] ?? match[2] ?? '').trim());
		}
	}
	return urls;
}

interface CssImageFunction {
	start: number;
	end: number;
	urls: string[];
}

/** The image functions in one declaration, outermost only, in order. */
function imageFunctions(declaration: string): CssImageFunction[] {
	const fns: CssImageFunction[] = [];
	const re = new RegExp(CSS_IMAGE_FUNCTION_RE.source, 'gi');
	let match: RegExpExecArray | null;
	while ((match = re.exec(declaration))) {
		const start = match.index;
		const end = closingParen(declaration, start + match[0].length - 1);
		fns.push({ start, end, urls: imageFunctionUrls(declaration.slice(start, end)) });
		// Skip past the whole function: a url() inside an image-set is its own.
		re.lastIndex = end;
	}
	return fns;
}

/**
 * Gate one CSS declaration. Each image function that fetches a withheld URL
 * is rewritten to `none`, so `background:#000 url(…)` keeps its colour (and
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
	for (const fn of imageFunctions(declaration)) {
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
			url = url.replace(/,+$/, '');
			candidates.push({ url, text: url });
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
