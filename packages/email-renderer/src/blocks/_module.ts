/**
 * Block module — the per-block-type vertical that owns rendering, plaintext,
 * AMP, validation, default factory, placement metadata, and compatibility data.
 *
 * See `docs/adr/0001-block-module-deepening.md` and the project glossary at
 * `CONTEXT.md` (Block, Block module, Placement, Allotted width, Walker).
 *
 * Block authors implement `BlockModule<T>`. The Walker dispatches by `type` and
 * handles placement-specific wrapping; modules return inner HTML only and never
 * inspect their parent's identity.
 */

import type { EditorBlock, BlockType, EmailTheme, FeatureCompatibility, PropertyCompatibility } from '@owlat/shared';
import type { RenderContext } from '../types';
import type { ValidatorContext } from '../validators/registry';

/**
 * Layout descriptor returned by `BlockModule.layout?()`.
 *
 * Each field overrides the Walker's default for that one concern; omit any
 * field to fall through to the default. This is how blocks declare the few
 * placement-side things that aren't pure HTML — the section's background
 * source, its padding, and whether the section's own outer wrap should sum
 * padding+margin (`'normal'`) or only apply margin and let the block emit
 * its own inner padding (`'outer-only'`, e.g. hero with a full-bleed bg).
 */
export interface BlockLayout {
	/** Section background color. Omit → Walker reads `content.backgroundColor`. */
	background?: string;
	/** CSS padding shorthand for the section's outer `<td>`. Omit → Walker computes padding+margin sum. */
	padding?: string;
	/** How the Walker wraps the block. Default `'normal'`. */
	sectionMode?: 'normal' | 'outer-only';
}

/** Where a Block sits in the email tree. */
export type Placement = 'root' | 'column' | 'container' | 'hero';

/**
 * Lift a nested content item (a column/container/section child carrying
 * `{ id, type, content }`) into an `EditorBlock` so composite blocks can hand
 * it to their `walk` recursion entry. This is the one unsafe cast in the block
 * renderers: the nested item shapes are structurally `EditorBlock`s but typed
 * as their own item unions, so the cast is centralised here rather than
 * scattered across every composite module.
 */
export const itemToBlock = (item: { id: string; type: string; content: unknown }): EditorBlock =>
	({ id: item.id, type: item.type, content: item.content } as EditorBlock);

/** Narrow `EditorBlock` to the variant matching one type discriminant. */
export type BlockOf<T extends BlockType> = Extract<EditorBlock, { type: T }>;
export type ContentOf<T extends BlockType> = BlockOf<T>['content'];

/** Walker recursion entry for HTML — composite blocks call this for each child. */
export type HtmlWalk = (
	child: EditorBlock,
	childWidth: number,
	childPlacement: Placement,
) => string;

/** Walker recursion entry for plaintext. */
export type PlaintextWalk = (child: EditorBlock) => string;

/** Args passed to `html()` and `preflight()`. */
export interface RenderArgs<T extends BlockType> {
	block: BlockOf<T>;
	/** Convenience alias for `block.content`. */
	content: ContentOf<T>;
	ctx: RenderContext;
	/** Pixel width budget at this placement. baseWidth at root, column-share inside columns. */
	width: number;
	placement: Placement;
	/** Recursion entry for composite blocks (columns/container/hero). */
	walk: HtmlWalk;
}

/** Args passed to `plaintext()`. */
export interface PlainArgs<T extends BlockType> {
	block: BlockOf<T>;
	content: ContentOf<T>;
	/** Recursion entry for composite blocks. */
	walk: PlaintextWalk;
}

/** Args passed to `amp()`. */
export interface AmpArgs<T extends BlockType> {
	block: BlockOf<T>;
	content: ContentOf<T>;
	/** AMP walker for composite blocks that recurse into children. */
	walk: PlaintextWalk;
}

/** Args passed to `validate()`. */
export interface ValidateArgs<T extends BlockType> {
	block: BlockOf<T>;
	content: ContentOf<T>;
	ctx: ValidatorContext;
}

/**
 * The Block module — single source of truth for one block type.
 *
 * Invariants:
 * - `html`, `plaintext`, `amp` MUST be referentially transparent for the same
 *   input (no I/O, no globals).
 * - `validate` MUST NOT depend on the render context — only on block content
 *   and the validator state.
 * - Blocks are placement-blind: they may read `args.placement`,
 *   `args.width`, and `args.ctx` but never inspect their parent's identity.
 *   Layout data flows down via the context.
 * - Composite blocks (`columns`, `container`, `hero`) MUST recurse via
 *   `args.walk` — they never call other block modules directly.
 * - The Walker — not the block — emits placement-specific wrapping
 *   (`wrapSection`, column-cell, container-cell).
 */
export interface BlockModule<T extends BlockType> {
	readonly type: T;

	/** Required: inner HTML for the block. The Walker wraps this for placement. */
	html(args: RenderArgs<T>): string;

	/** Placements this block accepts. Default: `['root']`. */
	placements?: readonly Placement[];

	/** Plain text for multipart emails. Default: block is skipped. */
	plaintext?(args: PlainArgs<T>): string;

	/** AMP4Email variant. Default: block is omitted from AMP output. */
	amp?(args: AmpArgs<T>): string | undefined;

	/** Domain-level validation (shape + semantic). Pushes to `args.ctx.issues`. */
	validate?(args: ValidateArgs<T>): void;

	/** Render-time warnings (pushed onto `args.ctx.warnings`). Default: no-op. */
	preflight?(args: RenderArgs<T>): void;

	/**
	 * Empty-content predicate. The Walker returns '' early when true, avoiding
	 * the placement wrapper. Default: never empty.
	 */
	isEmpty?(content: ContentOf<T>): boolean;

	/**
	 * Compatibility data for scoring, audience-reach math, and builder-UI
	 * limitation tooltips. Read by the Compatibility walker
	 * (`packages/email-renderer/src/compatibility/walker.ts`), which dispatches
	 * to every registered Block module. Default: no entries — the block is
	 * treated as fully supported everywhere.
	 *
	 * - `features` — block-level rules (e.g. "Web fonts work like X in text").
	 * - `properties` — per-property rules below feature granularity. The
	 *   `blockType` is implied by the owning module and not stored on each entry.
	 */
	compatibility?: {
		features?: readonly FeatureCompatibility[];
		properties?: readonly PropertyCompatibility[];
	};

	/** Default content for the editor's "add block" affordance. */
	createDefault?(theme: EmailTheme): ContentOf<T>;

	/**
	 * Section-layout overrides. The Walker consults this when wrapping the block
	 * in its section table. Return any subset of {background, padding,
	 * sectionMode}; omitted fields fall through to the Walker defaults
	 * (background from `content.backgroundColor`, padding from padding+margin
	 * sum, sectionMode `'normal'`).
	 *
	 * Use cases today:
	 * - `button` returns `{ background: content.blockBackgroundColor }` because
	 *   its own `backgroundColor` is the button's fill, not the section's.
	 * - `hero` returns `{ sectionMode: 'outer-only' }` because its
	 *   background image needs to cover the full block — the Walker should
	 *   only apply margin as outer spacing, leaving inner padding to the hero.
	 */
	layout?(content: ContentOf<T>): BlockLayout;

	/**
	 * Apply theme-derived defaults to the block's content before render. Called
	 * once at the top of the render pipeline after the universal
	 * `theme.blockDefaults[type]` merge. The module reads the theme keys it
	 * cares about (e.g. `text` reads `headingDefaults`, `button` reads
	 * `buttonDefaults`) and returns the merged content. Block-level values
	 * always win — modules MUST preserve any explicit field already set on
	 * `content`.
	 *
	 * Default: no theme-defaults are applied beyond the universal blockDefaults
	 * merge.
	 */
	applyTheme?(content: ContentOf<T>, theme: EmailTheme): ContentOf<T>;

	/**
	 * Emit responsive CSS rules for this block (e.g. mobile font sizing). The
	 * Walker calls this once per block during the pre-render sweep and pushes
	 * the returned rules onto `ctx.responsiveRules` for the document-level
	 * `<style>` block.
	 *
	 * Rules SHOULD scope themselves with `[data-block-id="${block.id}"]` so
	 * they don't leak across blocks.
	 *
	 * Default: no responsive rules emitted.
	 */
	responsiveCss?(args: RenderArgs<T>): readonly string[];
}
