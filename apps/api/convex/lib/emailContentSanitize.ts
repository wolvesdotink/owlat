/**
 * Write-time sanitization of stored editor content.
 *
 * Email templates, transactional emails and saved blocks keep their editor
 * state as a JSON string, and the builder loads a text block's `html` into a
 * live contenteditable. Every write of that JSON runs the text-block HTML
 * through `sanitizeEditorHtml`, the same policy the builder applies on load and
 * on commit, so stored content matches what the editors would produce.
 *
 * The same pass normalizes numeric style fields (padding, margin, sizes): a
 * numeric string becomes a number and any other non-number value is dropped,
 * so the renderer falls back to its default. The renderer coerces these
 * fields too; this keeps the stored JSON in the shape the types describe.
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

/**
 * Block content fields typed `number` in `@owlat/shared` that end up in style
 * or sizing attributes. `width` and `value` are left out: `TableColumn.width`
 * and `BlockCondition.value` are strings under the same names. They are
 * handled per block type by {@link NUMERIC_CONTENT_FIELDS_BY_TYPE}.
 */
const NUMERIC_STYLE_FIELDS: ReadonlySet<string> = new Set([
	'paddingTop',
	'paddingRight',
	'paddingBottom',
	'paddingLeft',
	'marginTop',
	'marginRight',
	'marginBottom',
	'marginLeft',
	'borderWidth',
	'borderRadius',
	'buttonBorderWidth',
	'bulletSize',
	'cellPadding',
	'colSpan',
	'rowSpan',
	'columnGap',
	'fontSize',
	'fontWeight',
	'headerFontSize',
	'height',
	'iconSize',
	'iconSpacing',
	'iconWidth',
	'itemSpacing',
	'labelFontSize',
	'letterSpacing',
	'lineHeight',
	'maxValue',
	'maxWidth',
	'mobileFontSize',
	'paddingX',
	'paddingY',
	'playButtonSize',
	'thickness',
	'thumbnailWidth',
]);

/**
 * Numeric content fields whose names other shapes use for strings, keyed by
 * the block type whose `content` holds them as numbers.
 */
const NUMERIC_CONTENT_FIELDS_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
	image: ['width'],
	video: ['width'],
	divider: ['width'],
	progressBar: ['value'],
};

/**
 * Normalize `node[key]` in place when present: finite numbers and null stay,
 * numeric strings become numbers, anything else is removed. Returns whether it
 * changed.
 */
function normalizeNumericField(node: JsonObject, key: string): boolean {
	if (!(key in node)) return false;
	const value = node[key];
	if (value === null || (typeof value === 'number' && Number.isFinite(value))) return false;
	const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
	if (Number.isFinite(parsed)) node[key] = parsed;
	else delete node[key];
	return true;
}

/** Normalize the numeric style fields of one object in place. Returns whether anything changed. */
function normalizeNumericFields(node: JsonObject): boolean {
	let changed = false;
	for (const key of Object.keys(node)) {
		if (NUMERIC_STYLE_FIELDS.has(key)) changed = normalizeNumericField(node, key) || changed;
	}
	const typed =
		typeof node['type'] === 'string' ? NUMERIC_CONTENT_FIELDS_BY_TYPE[node['type']] : undefined;
	const content = node['content'];
	if (typed && isObject(content)) {
		for (const key of typed) changed = normalizeNumericField(content, key) || changed;
	}
	return changed;
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
 * Walk a parsed block tree, sanitize the `content.html` of every text block
 * and normalize numeric style fields, however deeply they are nested
 * (columns, column styles, containers, hero items, table cells, the
 * saved-block envelope). Returns whether anything changed.
 */
function sanitizeBlockTree(node: unknown): boolean {
	if (Array.isArray(node)) {
		let changed = false;
		for (const entry of node) changed = sanitizeBlockTree(entry) || changed;
		return changed;
	}
	if (!isObject(node)) return false;

	let changed = normalizeNumericFields(node);
	if (node['type'] === 'text' && isObject(node['content'])) {
		changed = sanitizeField(node['content'], 'html') || changed;
	}
	for (const value of Object.values(node)) {
		if (typeof value === 'object' && value !== null) {
			changed = sanitizeBlockTree(value) || changed;
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
 * Sanitize the text-block HTML and numeric style fields inside stored block
 * JSON: a bare block array, the `{ blocks }` envelope or a single legacy
 * block. The string comes back untouched when nothing needed cleaning or it is
 * not valid JSON (every reader treats unparseable content as empty).
 */
export function sanitizeStoredBlocksJson(json: string): string;
export function sanitizeStoredBlocksJson(json: string | undefined): string | undefined;
export function sanitizeStoredBlocksJson(json: string | undefined): string | undefined {
	if (json === undefined) return undefined;
	const parsed = tryParse(json);
	if (parsed === undefined) return json;
	return sanitizeBlockTree(parsed) ? JSON.stringify(parsed) : json;
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
