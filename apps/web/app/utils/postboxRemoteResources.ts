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
			// A newline ends a CSS string (as a bad string) just like its quote.
			if (ch === quote || isCssNewline(ch)) quote = null;
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

function isCssNewline(ch: string | undefined): boolean {
	return ch === '\n' || ch === '\r' || ch === '\f';
}

function isCssWhitespace(ch: string | undefined): boolean {
	return ch === ' ' || ch === '\t' || isCssNewline(ch);
}

function isCssIdentChar(ch: string): boolean {
	return /[\w-]/.test(ch) || ch.charCodeAt(0) >= 0x80;
}

/** A `\` at `at` starts an escape unless a newline follows it. */
function isCssEscape(value: string, at: number): boolean {
	return value[at] === '\\' && !isCssNewline(value[at + 1]);
}

/**
 * Decode the escape whose `\` is at `at` (CSS Syntax 4.3.7): 1-6 hex digits
 * plus one optional whitespace, or the next character as itself. Out-of-range
 * code points and a trailing `\` read as U+FFFD, as the browser reads them.
 */
function decodeCssEscape(value: string, at: number): { text: string; next: number } {
	let i = at + 1;
	if (i >= value.length) return { text: '\uFFFD', next: i };
	let hex = '';
	while (hex.length < 6 && i < value.length && /[\da-f]/i.test(value[i]!)) hex += value[i++];
	if (hex) {
		if (value[i] === '\r' && value[i + 1] === '\n') i += 2;
		else if (isCssWhitespace(value[i])) i++;
		const code = Number.parseInt(hex, 16);
		const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
		return { text: valid ? String.fromCodePoint(code) : '\uFFFD', next: i };
	}
	const ch = String.fromCodePoint(value.codePointAt(i)!);
	return { text: ch, next: i + ch.length };
}

/** Read the quoted string opening at `at`, escapes decoded. */
function readCssString(value: string, at: number): { text: string; next: number } {
	const quote = value[at];
	let text = '';
	let i = at + 1;
	while (i < value.length) {
		const ch = value[i]!;
		if (ch === quote) return { text, next: i + 1 };
		// An unescaped newline ends the string (the browser drops it as bad).
		if (isCssNewline(ch)) return { text, next: i };
		if (ch === '\\') {
			if (isCssNewline(value[i + 1])) {
				// A line continuation.
				i += value[i + 1] === '\r' && value[i + 2] === '\n' ? 3 : 2;
				continue;
			}
			if (i + 1 >= value.length) break;
			const escape = decodeCssEscape(value, i);
			text += escape.text;
			i = escape.next;
			continue;
		}
		text += ch;
		i++;
	}
	return { text, next: i };
}

/** Read the identifier starting at `at`, escapes decoded. */
function readCssIdent(value: string, at: number): { name: string; next: number } {
	let name = '';
	let i = at;
	while (i < value.length) {
		if (isCssEscape(value, i)) {
			const escape = decodeCssEscape(value, i);
			name += escape.text;
			i = escape.next;
		} else if (isCssIdentChar(value[i]!)) {
			name += value[i++];
		} else {
			break;
		}
	}
	return { name, next: i };
}

/**
 * Tokenize one declaration in a single linear pass and collect, per
 * top-level function, every reference the browser could fetch. Rather than
 * know which functions take images (and miss a nesting such as
 * `cross-fade(image-set("…"))`), it fails closed: every `url(…)` token and
 * every quoted string inside a function, at any depth, counts, except a
 * string directly inside `type()`, which names a MIME type. A quoted string
 * outside every function (a `font-family` name) is never fetched. Escapes are
 * decoded the way the browser decodes them, so `\75 rl(…)` is a `url(…)` and
 * `\23 000` is just a colour. Comments are skipped; an unterminated string,
 * comment or function runs to the end.
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
			const string = readCssString(value, i);
			if (current.unit && stack[stack.length - 1] !== 'type') {
				current.unit.urls.push(string.text.trim());
			}
			i = string.next;
		} else if (ch === '(') {
			open('', i);
			i++;
		} else if (ch === ')') {
			if (stack.length > 0) close(i + 1);
			i++;
		} else if (isCssIdentChar(ch) || isCssEscape(value, i)) {
			const ident = readCssIdent(value, i);
			if (value[ident.next] !== '(') {
				i = ident.next;
				continue;
			}
			const name = ident.name.toLowerCase();
			open(name, i);
			i = ident.next + 1;
			if (name !== 'url') continue;
			let k = i;
			while (k < length && isCssWhitespace(value[k])) k++;
			if (value[k] === '"' || value[k] === "'") continue;
			// An unquoted url token runs to the next `)`, escapes decoded.
			let url = '';
			while (k < length && value[k] !== ')') {
				if (isCssEscape(value, k)) {
					const escape = decodeCssEscape(value, k);
					url += escape.text;
					k = escape.next;
				} else {
					url += value[k++];
				}
			}
			current.unit?.urls.push(url.trim());
			close(Math.min(k + 1, length));
			i = k + 1;
		} else {
			i++;
		}
	}
	if (current.unit) units.push(current.unit);
	return units;
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
		for (const declaration of splitDeclarations(style)) {
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

		if (outcome.replacement === 'placeholder') {
			el.replaceWith(blockedPlaceholder(doc, outcome.blockedUrl, blockedLabel));
		} else if (outcome.replacement === 'remove') {
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
