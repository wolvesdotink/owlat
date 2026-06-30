import type { EditorBlock, ColumnItem, ContainerItem } from '@owlat/shared';
import type { RenderContext } from '../types';
import { wrapSection } from '../helpers/table';
import type { BlockLayout, BlockModule, BlockOf, HtmlWalk, Placement, RenderArgs } from './_module';
import { moduleFor } from './_registry';
// Side-effect import: registers built-in Block modules with the registry.
import './_builtin-modules';

/**
 * Block renderer function signature for custom blocks.
 * Receives the block content (typed as unknown for custom blocks) and render context.
 * Returns the inner HTML (will be wrapped by wrapSection automatically).
 */
export type BlockRenderer = (content: unknown, ctx: RenderContext, block: EditorBlock) => string;

/**
 * Registry for custom block renderers.
 * Built-in blocks use the switch statement; custom blocks are looked up here.
 * After finalizeRegistry() is called, no further mutations are allowed.
 */
const customBlockRegistry = new Map<string, BlockRenderer>();
let registryFrozen = false;

/**
 * Register a custom block renderer.
 * Custom blocks are rendered after the built-in switch statement (built-in types cannot be overridden).
 * The renderer receives the block content and render context, and should return inner HTML.
 * Must be called before finalizeRegistry().
 */
export const registerBlock = (type: string, renderer: BlockRenderer): void => {
	if (registryFrozen) {
		throw new Error(`Cannot register block "${type}": registry is frozen. Call registerBlock() during setup before finalizeRegistry().`);
	}
	customBlockRegistry.set(type, renderer);
};

/**
 * Unregister a custom block renderer.
 * Must be called before finalizeRegistry().
 */
export const unregisterBlock = (type: string): void => {
	if (registryFrozen) {
		throw new Error(`Cannot unregister block "${type}": registry is frozen.`);
	}
	customBlockRegistry.delete(type);
};

/**
 * Freeze the block registry to prevent further mutations.
 * Call this after all custom blocks have been registered during setup.
 */
export const finalizeRegistry = (): void => {
	registryFrozen = true;
};

/**
 * Check whether the registry has been frozen.
 */
export const isRegistryFinalized = (): boolean => {
	return registryFrozen;
};

/**
 * Get all registered custom block types.
 */
export const getRegisteredBlocks = (): string[] => {
	return Array.from(customBlockRegistry.keys());
};

/**
 * Apply the root section wrap to a block's inner HTML.
 *
 * At root placement, the Walker emits the section table around the block's
 * inner HTML — padding, background, border, full-width, dark-mode classes.
 *
 * At non-root placements (column / container / hero) the Block module is
 * responsible for its own placement-specific shell. Different blocks need
 * different shells: text-style fuses into the column td, spacer IS the cell,
 * divider gets a padding wrapper. Trying to apply a uniform Walker wrap here
 * would force every block to render against the same template, which the
 * historical `renderColumnItem` switch already proves is wrong.
 */
const wrapForPlacement = (
	block: EditorBlock,
	inner: string,
	ctx: RenderContext,
	placement: Placement,
	layout?: BlockLayout,
): string => {
	return placement === 'root' ? wrapSection(block, inner, ctx, layout) : inner;
};

/**
 * Hybrid dispatch helper: if a Block module is registered for `block.type`,
 * run the new render path. Otherwise return null so the caller can fall through
 * to the legacy switch.
 *
 * Verifies the module accepts the placement (defaults to `['root']`) and
 * applies the Walker-owned wrapping.
 */
const dispatchBlockModule = (
	block: EditorBlock,
	ctx: RenderContext,
	width: number,
	placement: Placement,
): string | null => {
	const mod = moduleFor(block.type);
	if (!mod) return null;

	const accepted = mod.placements ?? ['root'];
	if (!accepted.includes(placement)) return '';

	type T = typeof block.type;
	const typed = block as BlockOf<T>;
	if (mod.isEmpty?.(typed.content)) return '';

	const walk: HtmlWalk = (child, childWidth, childPlacement) => {
		const viaModule = dispatchBlockModule(child, ctx, childWidth, childPlacement);
		if (viaModule !== null) return viaModule;
		// Legacy fallback: delegate to the per-placement renderer below.
		switch (childPlacement) {
			case 'root':
				return renderBlock(child, ctx);
			case 'column':
				return renderColumnItem(child as ColumnItem, childWidth, ctx);
			case 'container':
				return renderContainerItem(child as ContainerItem, childWidth, ctx);
			case 'hero':
				return '';
		}
	};

	const args: RenderArgs<T> = {
		block: typed,
		content: typed.content,
		ctx,
		width,
		placement,
		walk,
	};
	const m = mod as BlockModule<T>;
	m.preflight?.(args);
	const responsive = m.responsiveCss?.(args);
	if (responsive) {
		for (const rule of responsive) ctx.responsiveRules.push(rule);
	}
	const layout = m.layout?.(typed.content);
	const inner = m.html(args);
	return wrapForPlacement(block, inner, ctx, placement, layout);
};

/**
 * Render a top-level EditorBlock to HTML, wrapped in a section table.
 *
 * All built-in types are now Block modules; the legacy switch is gone. The
 * fallback path serves only the legacy `registerBlock(type, renderer)` custom
 * renderer API. New code should call `registerBlockModule()` instead — see
 * `_module.ts`.
 */
export const renderBlock = (block: EditorBlock, ctx: RenderContext): string => {
	const viaModule = dispatchBlockModule(block, ctx, ctx.baseWidth, 'root');
	if (viaModule !== null) return viaModule;

	// Legacy custom-block API: an HTML-only renderer registered against a string type.
	const customRenderer = customBlockRegistry.get(block.type);
	if (!customRenderer) return '';
	const innerHtml = customRenderer(block.content, ctx, block);
	return wrapSection(block, innerHtml, ctx);
};

/**
 * Render a ColumnItem at the `column` placement. All built-in column items
 * are now Block modules; this function is a thin walker dispatch.
 */
export const renderColumnItem = (item: ColumnItem, baseWidth: number, ctx: RenderContext): string => {
	const viaModule = dispatchBlockModule(item as unknown as EditorBlock, ctx, baseWidth, 'column');
	return viaModule ?? '';
};

/**
 * Render a ContainerItem at the `container` placement. All built-in container
 * items are now Block modules; this function is a thin walker dispatch.
 */
export const renderContainerItem = (item: ContainerItem, baseWidth: number, ctx: RenderContext): string => {
	const viaModule = dispatchBlockModule(item as unknown as EditorBlock, ctx, baseWidth, 'container');
	return viaModule ?? '';
};
