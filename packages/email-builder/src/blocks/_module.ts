/**
 * Editor module — the per-block-type editor half that owns label, icon, panel
 * schema, slash-menu entry, capability flags, column-context default factory,
 * and composite-block child views. Mirrors the renderer's `BlockModule<T>`
 * (in `@owlat/email-renderer/blocks/_module`) on the builder side.
 *
 * See `docs/adr/0001-block-module-deepening.md` and the project glossary at
 * `CONTEXT.md` (Block, Block module, Placement). Together with the renderer
 * module, an Editor module forms the "Block module" the docs refer to —
 * physically split across two packages because one half imports Vue components
 * and the other runs on the server/CLI.
 *
 * Block authors write one file per type per package. The Walker (renderer
 * side) and the editor surfaces (panel, canvas, nested-items, slash menu)
 * dispatch by `type` via a typed registry — adding a new block touches the
 * type union, the renderer module folder, and the editor module folder. No
 * cross-cutting switches remain.
 */

import type { Component } from 'vue';
import type {
	BlockType,
	BlockTypeContentMap,
	EditorBlock,
	EmailTheme,
} from '../types';
import type { BlockAttributeSchema } from '../schema/types';

/** Narrow `EditorBlock` to the variant matching one type discriminant. */
export type BlockOf<T extends BlockType> = Extract<EditorBlock, { type: T }>;

/** A single child entry surfaced by composite blocks in the panel. */
export interface NestedChild {
	id: string;
	type: string;
	label: string;
	icon: Component | null;
}

/**
 * Slash-command metadata. The icon is reused from the editor module's
 * top-level `icon` field, so it's omitted here to avoid duplication.
 */
export interface SlashCommandMeta {
	name: string;
	description: string;
	category: 'text' | 'media' | 'layout' | 'components';
	aliases?: string[];
}

/**
 * The Editor module — single source of truth for one block type on the
 * builder side. Authors implement this interface; the registry dispatches by
 * `type`. Optional fields default to "feature not supported."
 */
export interface EditorModule<T extends BlockType> {
	readonly type: T;

	/** Display name shown in the panel header, slash menu, etc. */
	label: string;

	/** Lucide icon component for the panel, slash menu, and child views. */
	icon: Component;

	/** Property-panel schema. Omit for blocks with no settings UI. */
	schema?: BlockAttributeSchema;

	/** Slash-menu entry. `null` to omit from the slash menu. */
	slashCommand?: SlashCommandMeta | null;

	/**
	 * Override the bridge-computed root-placement `createDefault`. The bridge
	 * default is `{ ...rendererModule.createDefault(theme), ...defaultPadding,
	 * ...defaultMargin }`. Provide this when the block needs builder-specific
	 * post-processing (e.g. `button` recomputes `textColor` for contrast
	 * against the theme's primary color, `container` opts out of the
	 * defaultPadding/Margin spread, `accordion` regenerates section IDs).
	 *
	 * When implemented, the editor module owns the entire composition — the
	 * bridge does not spread `defaultPadding` / `defaultMargin` on top.
	 */
	createDefault?: (theme: EmailTheme) => BlockTypeContentMap[T];

	/**
	 * Default content when the block is dropped *inside a column*. Column
	 * children typically want tighter padding/typography than their root-
	 * placement counterparts. Falls back to the renderer module's
	 * `createDefault(theme)` when omitted.
	 */
	createDefaultColumnItem?: (theme: EmailTheme) => BlockTypeContentMap[T];

	// --- Capability flags ---

	/** Can this block be inserted inside a `columns` block's column? */
	canBeInColumn?: boolean;
	/** Can this block be inserted inside a `container` or `hero` block? */
	canBeInContainer?: boolean;
	/** Does this block expose a border-radius setting? */
	supportsBorderRadius?: boolean;
	/** Focus the text editor immediately after inserting this block? */
	focusOnInsert?: boolean;

	// --- Composite-block surface ---

	/**
	 * For composite blocks (`columns`, `container`, `hero`, `accordion`):
	 * project the block's children into a flat list for the
	 * `NestedItemsEditor` panel. The Walker doesn't recurse here — this is
	 * presentation only.
	 */
	childrenView?: (block: BlockOf<T>) => NestedChild[];

	/**
	 * For composite blocks: which block types can be inserted as children.
	 * The implementation typically calls `getColumnItemTypes()` or
	 * `getContainerItemTypes()` from the registry — capability flags on every
	 * other module are the source of truth, so the registry's queries stay
	 * the answer rather than duplicating an allowlist here.
	 */
	allowedChildTypes?: () => string[];
}

/**
 * Typed module map. Every `BlockType` must have an entry — missing entries
 * are compile errors at the registry boundary.
 */
export type EditorModuleMap = {
	[T in BlockType]: EditorModule<T>;
};
