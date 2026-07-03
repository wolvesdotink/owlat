import type { EditorBlock, BlockCondition, BlockRepeat, CommonBlockProperties } from '@owlat/shared';
import type { RenderOptions, RenderContext } from './types';
import { wrapDocument } from './boilerplate';
import { renderBlock } from './blocks';
import { moduleFor } from './blocks/_registry';
import { inlineCss } from './inliner';
import { escapeJsonValue } from './sanitize';
import { simulateClient } from './simulators';
import { validateBlocks } from './validator';

const MAX_WARNINGS = 50;
const addWarning = (ctx: RenderContext, message: string): void => {
	if (ctx.warnings.length >= MAX_WARNINGS) {
		if (ctx.warnings.length === MAX_WARNINGS) {
			ctx.warnings.push(`... further warnings suppressed (limit: ${MAX_WARNINGS})`);
		}
		return;
	}
	// Deduplicate by message
	if (!ctx.warnings.includes(message)) {
		ctx.warnings.push(message);
	}
};

export const DEFAULT_BASE_WIDTH = 600;

const DEFAULT_THEME = {
	primaryColor: '#c4785a',
	fontFamily: 'Arial, sans-serif',
	backgroundColor: '#ffffff',
	darkModeBackgroundColor: '#121212',
	darkModeTextColor: '#e4e4e7',
	darkModeLinkColor: '#93c5fd',
};

const createContext = (options: RenderOptions = {}): RenderContext => {
	const theme = { ...DEFAULT_THEME, ...options.theme };
	const darkMode = options.darkMode ?? false;
	const variableType = options.variableType ?? 'personalization';

	return {
		theme,
		darkMode,
		variableType,
		variableClass: variableType === 'personalization' ? 'personalization-variable' : 'data-variable',
		baseWidth: options.baseWidth ?? options.theme?.baseWidth ?? DEFAULT_BASE_WIDTH,
		preheaderText: options.preheaderText ?? '',
		title: options.title ?? '',
		breakpoint: options.breakpoint ?? 480,
		direction: options.direction ?? 'ltr',
		fontUrls: options.fontUrls ?? [],
		customCss: options.customCss ?? '',
		variableValues: options.variableValues ?? {},
		lang: options.lang ?? 'en',
		responsiveRules: [],
		globalRules: [],
		linkTransform: options.linkTransform,
		warnings: [],
		gmailAnnotations: options.gmailAnnotations,
	};
};

/**
 * Evaluate a block condition against variable values.
 */
const evaluateCondition = (condition: BlockCondition, variables: Record<string, string>): boolean => {
	const value = variables[condition.variable];
	switch (condition.operator) {
		case 'exists':
			return value !== undefined && value !== '';
		case 'notExists':
			return value === undefined || value === '';
		case 'equals':
			return value === condition.value;
		case 'notEquals':
			return value !== condition.value;
		case 'contains':
			return value !== undefined && condition.value !== undefined && value.includes(condition.value);
		default:
			return true;
	}
};

/** Maximum total blocks after repeat expansion to prevent resource exhaustion */
const MAX_EXPANDED_BLOCKS = 5000;

/** Maximum items per single repeat block to prevent excessive expansion */
const MAX_REPEAT_ITEMS = 500;

/**
 * Expand blocks with repeat configuration into multiple block instances.
 * For each item in the array variable, creates a clone of the block with
 * the item's properties available as {{itemAlias.key}} in text content.
 */
const expandRepeats = (blocks: EditorBlock[], ctx: RenderContext): EditorBlock[] => {
	const result: EditorBlock[] = [];

	for (const block of blocks) {
		const c = block.content as CommonBlockProperties;
		const repeat = c.repeat as BlockRepeat | undefined;

		if (!repeat) {
			result.push(block);
			continue;
		}

		// Parse the array variable (expects JSON-encoded array string)
		const rawValue = ctx.variableValues[repeat.variable];
		if (!rawValue) {
			addWarning(ctx, `Repeat variable "${repeat.variable}" not found in variableValues — block "${block.id}" skipped.`);
			continue;
		}

		let items: Record<string, string>[];
		try {
			items = JSON.parse(rawValue);
			if (!Array.isArray(items)) {
				addWarning(ctx, `Repeat variable "${repeat.variable}" is not an array — block "${block.id}" skipped.`);
				continue;
			}
		} catch {
			addWarning(ctx, `Repeat variable "${repeat.variable}" is not valid JSON — block "${block.id}" skipped.`);
			continue;
		}

		// Limit items: respect maxItems, but also enforce safety cap
		const limit = Math.min(repeat.maxItems ?? items.length, MAX_REPEAT_ITEMS);
		const limitedItems = items.slice(0, limit);

		if (items.length > limit) {
			addWarning(ctx, `Repeat variable "${repeat.variable}" has ${items.length} items but was capped at ${limit} — block "${block.id}".`);
		}

		for (let i = 0; i < limitedItems.length; i++) {
			const item = limitedItems[i];
			// Clone the block with a unique ID. We cast through `unknown` because
			// the spread breaks the `type`/`content` discriminator linkage that
			// TS6 enforces more strictly on the EditorBlock union.
			const clonedBlock = {
				...block,
				id: `${block.id}-repeat-${i}`,
				content: structuredClone(block.content),
			} as unknown as EditorBlock;

			// Replace {{alias.key}} placeholders in text content
			if (typeof item === 'object' && item !== null) {
				const contentStr = JSON.stringify(clonedBlock.content);
				let replaced = contentStr;
				for (const [key, value] of Object.entries(item)) {
					const placeholder = `{{${repeat.itemAlias}.${key}}}`;
					// Escape value for safe JSON string interpolation to prevent JSON injection
					replaced = replaced.split(placeholder).join(escapeJsonValue(String(value)));
				}
				// Also replace {{$index}} with the iteration index
				replaced = replaced.split('{{$index}}').join(String(i));
				// Guard the re-parse (mirrors the array parse above): a value that
				// still produces invalid JSON after escaping must not throw out of
				// renderEmailHtml and fail the whole recipient — skip this item.
				try {
					clonedBlock.content = JSON.parse(replaced);
				} catch {
					addWarning(ctx, `Repeat item ${i} for variable "${repeat.variable}" produced invalid JSON after substitution — item skipped in block "${block.id}".`);
					continue;
				}
			}

			// Remove the repeat config from cloned blocks to prevent infinite recursion
			const clonedContent = clonedBlock.content as CommonBlockProperties;
			delete clonedContent.repeat;

			result.push(clonedBlock);

			// Safety: prevent total expanded block count from growing unbounded
			if (result.length > MAX_EXPANDED_BLOCKS) {
				addWarning(ctx, `Repeat expansion exceeded ${MAX_EXPANDED_BLOCKS} total blocks — further repeats truncated.`);
				return result;
			}
		}
	}

	return result;
};

/**
 * Apply theme defaults to a block's content before rendering.
 *
 * Two passes:
 * 1. **Universal `blockDefaults[type]` merge.** The Walker shallow-merges
 *    `theme.blockDefaults[block.type]` into the content; block-level fields
 *    always win. This is the mj-attributes equivalent and is type-agnostic.
 * 2. **Per-module theme hook.** If the Block module exports
 *    `applyTheme(content, theme)`, the Walker calls it. Modules read whatever
 *    theme keys they care about (text reads `headingDefaults` /
 *    `bodyFontSize` / `bodyTextColor`; button reads `buttonDefaults`) and
 *    return the merged content. Block-level values still win — modules
 *    preserve any explicit fields already set on `content`.
 *
 * Adding a new theme key to a block type is a single-module change; the
 * Walker stays type-agnostic.
 */
const applyThemeDefaults = (block: EditorBlock, ctx: RenderContext): EditorBlock => {
	const theme = ctx.theme;
	let content: Record<string, unknown> = block.content as unknown as Record<string, unknown>;

	// Step 1: per-module theme hook runs against the ORIGINAL content. The
	// module reads only the fields the block-author left undefined and fills
	// them from its preferred theme keys (heading defaults, button defaults,
	// etc.). Explicit block-level fields are preserved.
	const mod = moduleFor(block.type);
	if (mod?.applyTheme) {
		content = mod.applyTheme(content as never, theme) as unknown as Record<string, unknown>;
	}

	// Step 2: universal `blockDefaults[type]` merge fills any field that is
	// still undefined after Step 1. Lowest priority — module's per-type theme
	// keys win, block-level explicit fields win above both.
	if (theme.blockDefaults?.[block.type]) {
		const defaults = theme.blockDefaults[block.type]!;
		const merged: Record<string, unknown> = { ...defaults };
		for (const key of Object.keys(content)) {
			if (content[key] !== undefined) {
				merged[key] = content[key];
			}
		}
		content = merged;
	}

	return { ...block, content } as unknown as EditorBlock;
};

/**
 * Render an array of EditorBlocks to a complete HTML email document.
 */
export const renderEmailHtml = (blocks: EditorBlock[], options?: RenderOptions): string => {
	const ctx = createContext(options);

	// Validate block content at the render boundary. The block-module
	// `validate?` methods cover shape + semantic + Outlook rules; we surface
	// only error-severity issues here to match the historical behaviour of
	// "shape errors become render-time warnings".
	const validation = validateBlocks(blocks, { level: options?.validationLevel });
	for (const issue of validation.issues) {
		if (issue.severity === 'error') {
			addWarning(ctx, `Block validation: ${issue.blockType}[${issue.blockId}]: ${issue.message}`);
		}
	}

	// Expand repeat blocks (iterate over array variables)
	const expandedBlocks = expandRepeats(blocks, ctx);

	const filteredBlocks = expandedBlocks
		.filter((block) => {
			// Evaluate conditional content
			const c = block.content as CommonBlockProperties;
			const condition = c.condition as BlockCondition | undefined;
			if (condition) {
				return evaluateCondition(condition, ctx.variableValues);
			}
			return true;
		})
		.map((block) => applyThemeDefaults(block, ctx));

	// Responsive CSS (e.g. mobile font sizes) is collected by the Walker
	// during dispatch via each module's `responsiveCss?()` hook; nothing to
	// pre-scan here.

	const bodyContent = filteredBlocks
		.map((block) => renderBlock(block, ctx))
		.filter(Boolean)
		.join('');

	// Forward warnings to callback
	if (options?.onWarning) {
		for (const w of ctx.warnings) {
			options.onWarning(w);
		}
	}

	let html = wrapDocument(bodyContent, ctx);

	// CSS inlining pass: inline computed styles onto elements for Gmail/Yahoo compatibility
	const shouldInline = options?.inlineCss !== false; // default: true
	if (shouldInline) {
		html = inlineCss(html);
	}

	if (options?.minify) {
		html = minifyHtml(html);
	}

	// Apply client simulation as the final step
	if (options?.targetClient) {
		html = simulateClient(html, options.targetClient);
	}

	return html;
};

/**
 * Render a single EditorBlock to an HTML fragment (no document wrapper).
 */
export const renderBlockFragment = (block: EditorBlock, options?: RenderOptions): string => {
	const ctx = createContext(options);
	const themedBlock = applyThemeDefaults(block, ctx);
	return renderBlock(themedBlock, ctx);
};

/**
 * HTML minification: collapse whitespace, strip comments (preserve MSO conditionals),
 * clean up style attributes.
 */
const minifyHtml = (html: string): string => {
	return html
		// Strip HTML comments EXCEPT MSO conditionals (<!--[if and <![endif]-->)
		.replace(/<!--(?!\[if)(?!<!\[endif\])[\s\S]*?-->/g, '')
		// Collapse whitespace between tags
		.replace(/>\s+</g, '><')
		// Collapse multiple spaces
		.replace(/\s{2,}/g, ' ')
		// Remove trailing semicolons in style attributes
		.replace(/;"/g, '"')
		// Collapse whitespace within style attribute values
		.replace(/style="([^"]*)"/g, (_match, styles: string) => {
			const cleaned = styles.replace(/\s*;\s*/g, ';').replace(/\s*:\s*/g, ':').trim();
			return `style="${cleaned}"`;
		})
		.trim();
};
