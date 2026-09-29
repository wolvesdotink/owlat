/**
 * Write-time sanitization of text-block HTML in stored editor content.
 *
 * Email templates, transactional emails and saved blocks keep their editor
 * state as a JSON string, and the builder loads a text block's `html` into a
 * live contenteditable. Every write of that JSON runs the text-block HTML
 * through `sanitizeEditorHtml`, the same policy the builder applies on load and
 * on commit, so stored content matches what the editors would produce.
 *
 * Pure helpers (no Convex-runtime imports). The only dependency is the
 * `@owlat/email-renderer/sanitize` entry, which pulls in `sanitize-html` and
 * nothing else from the renderer.
 */

import { sanitizeEditorHtml } from '@owlat/email-renderer/sanitize';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Sanitize `holder[key]` in place when it is a string. Returns whether it changed. */
function sanitizeField(holder: JsonObject, key: string): boolean {
	const value = holder[key];
	if (typeof value !== 'string') return false;
	const clean = sanitizeEditorHtml(value);
	if (clean === value) return false;
	holder[key] = clean;
	return true;
}

/**
 * Walk a parsed block tree and sanitize the `content.html` of every text
 * block, however deeply it is nested (columns, containers, hero items, the
 * saved-block envelope). Returns whether anything changed.
 */
function sanitizeTextBlocks(node: unknown): boolean {
	if (Array.isArray(node)) {
		let changed = false;
		for (const entry of node) changed = sanitizeTextBlocks(entry) || changed;
		return changed;
	}
	if (!isObject(node)) return false;

	let changed = false;
	if (node['type'] === 'text' && isObject(node['content'])) {
		changed = sanitizeField(node['content'], 'html');
	}
	for (const value of Object.values(node)) {
		if (typeof value === 'object' && value !== null) {
			changed = sanitizeTextBlocks(value) || changed;
		}
	}
	return changed;
}

/** Parse JSON, or `undefined` when it is not valid JSON. */
function tryParse(json: string): unknown {
	try {
		return JSON.parse(json) as unknown;
	} catch {
		return undefined;
	}
}

/**
 * Sanitize the text-block HTML inside stored block JSON: a bare block array,
 * the `{ blocks }` envelope or a single legacy block. The string comes back
 * untouched when nothing needed cleaning or it is not valid JSON (every reader
 * treats unparseable content as empty).
 */
export function sanitizeStoredBlocksJson(json: string): string;
export function sanitizeStoredBlocksJson(json: string | undefined): string | undefined;
export function sanitizeStoredBlocksJson(json: string | undefined): string | undefined {
	if (json === undefined) return undefined;
	const parsed = tryParse(json);
	if (parsed === undefined) return json;
	return sanitizeTextBlocks(parsed) ? JSON.stringify(parsed) : json;
}

/**
 * Sanitize the `html` of every entry in one language's overlay block map
 * (`Record<blockId, { html?, buttonText?, alt? }>`), in place. Returns whether
 * anything changed.
 */
function sanitizeOverlayBlocks(blocks: unknown): boolean {
	if (!isObject(blocks)) return false;
	let changed = false;
	for (const entry of Object.values(blocks)) {
		if (isObject(entry)) changed = sanitizeField(entry, 'html') || changed;
	}
	return changed;
}

/**
 * Sanitize an overlay block map given as JSON (the `blocks` argument of the
 * translation update mutations). Same untouched-string rules as above.
 */
export function sanitizeOverlayBlocksJson(json: string): string;
export function sanitizeOverlayBlocksJson(json: string | undefined): string | undefined;
export function sanitizeOverlayBlocksJson(json: string | undefined): string | undefined {
	if (json === undefined) return undefined;
	const parsed = tryParse(json);
	if (parsed === undefined) return json;
	return sanitizeOverlayBlocks(parsed) ? JSON.stringify(parsed) : json;
}

/**
 * Sanitize every overlay's block HTML in a `translations` blob
 * (`Record<language, { subject, previewText?, blocks }>`). Same
 * untouched-string rules as above.
 */
export function sanitizeTranslationsJson(json: string): string;
export function sanitizeTranslationsJson(json: string | undefined): string | undefined;
export function sanitizeTranslationsJson(json: string | undefined): string | undefined {
	if (json === undefined) return undefined;
	const parsed = tryParse(json);
	if (!isObject(parsed)) return json;
	let changed = false;
	for (const translation of Object.values(parsed)) {
		if (isObject(translation)) changed = sanitizeOverlayBlocks(translation['blocks']) || changed;
	}
	return changed ? JSON.stringify(parsed) : json;
}
