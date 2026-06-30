/**
 * Block definition API — the legacy, type-erased view of a block's editor
 * surface (label, schema, slash command, capability flags, createDefault).
 *
 * Built-in blocks no longer call `registerBlock(def)` directly. Each built-in
 * lives in its own `packages/email-builder/src/blocks/<type>/` folder as an
 * `EditorModule<T>` (the typed source of truth). This file bridges that
 * registry to the legacy `BlockDefinition` shape so existing consumers
 * (DocumentCanvas, BlockInsertToolbar, slash-command derivation, panel
 * lookups) keep working without touching their call sites.
 *
 * `registerBlock(def)` is preserved for third-party / dynamic blocks — they
 * supply a `BlockDefinition` and it lives alongside the built-ins.
 *
 * See `docs/adr/0001-block-module-deepening.md` for the full Block module
 * vertical: renderer half in `@owlat/email-renderer/blocks/<type>/`, editor
 * half in `@owlat/email-builder/blocks/<type>/`.
 */

import type { Component } from 'vue';
import { moduleFor } from '@owlat/email-renderer';
import type { BlockType, BlockContent, EmailTheme } from '../types';
import type { SlashCommand } from '../types';
import type { BlockAttributeSchema } from '../schema/types';
import { defaultPadding, defaultMargin } from '../defaults';
import {
	getAllEditorModules,
	editorModuleFor,
} from '../blocks/_registry';
import type { EditorModule } from '../blocks/_module';

/**
 * Block definition — type-erased view of a block's editor surface. Built-in
 * blocks compute this on demand from their `EditorModule<T>`. Third-party
 * blocks supply it directly via `registerBlock()`.
 */
export interface BlockDefinition {
	type: BlockType;
	/** UI display name (e.g. "Text", "Progress") */
	label: string;
	/** Schema for the property panel */
	schema?: BlockAttributeSchema;
	/** Factory to create default content for this block */
	createDefault: (theme: EmailTheme) => BlockContent;
	/**
	 * Optional factory for column-context defaults.
	 *
	 * When a block is dropped inside a column it typically wants more compact
	 * padding and tighter typography than its top-level counterpart. If a
	 * definition supplies this factory, createDefaultColumnItemContent() uses
	 * it; otherwise it falls back to `createDefault`.
	 *
	 * Only blocks with `canBeInColumn: true` should set this.
	 */
	createDefaultColumnItem?: (theme: EmailTheme) => BlockContent;
	/** Slash command config. null = no slash menu entry (e.g. virtual-only types). */
	slashCommand: {
		name: string;
		description: string;
		icon: Component;
		category: 'text' | 'media' | 'layout' | 'components';
		aliases?: string[];
	} | null;
	canBeInColumn: boolean;
	canBeInContainer: boolean;
	supportsBorderRadius: boolean;
	focusOnInsert: boolean;
}

// ---------------------------------------------------------------------------
// Bridge: EditorModule<T> → BlockDefinition
// ---------------------------------------------------------------------------

/**
 * Compose a built-in block's `createDefault` from the renderer module + the
 * universal padding/margin defaults. The editor module can opt out of the
 * universal spread by providing its own `createDefault` (button, container,
 * accordion do this).
 */
const composeCreateDefault = <T extends BlockType>(mod: EditorModule<T>): (theme: EmailTheme) => BlockContent => {
	if (mod.createDefault) {
		return (theme) => mod.createDefault!(theme) as unknown as BlockContent;
	}
	return (theme) => {
		const rendererMod = moduleFor(mod.type);
		const rendererDefault = rendererMod?.createDefault?.(theme) ?? {};
		return {
			...rendererDefault,
			...defaultPadding,
			...defaultMargin,
		} as BlockContent;
	};
};

const bridgeToDefinition = <T extends BlockType>(mod: EditorModule<T>): BlockDefinition => ({
	type: mod.type,
	label: mod.label,
	schema: mod.schema,
	createDefault: composeCreateDefault(mod),
	createDefaultColumnItem: mod.createDefaultColumnItem as ((theme: EmailTheme) => BlockContent) | undefined,
	slashCommand: mod.slashCommand
		? {
			name: mod.slashCommand.name,
			description: mod.slashCommand.description,
			icon: mod.icon,
			category: mod.slashCommand.category,
			aliases: mod.slashCommand.aliases,
		}
		: null,
	canBeInColumn: mod.canBeInColumn ?? false,
	canBeInContainer: mod.canBeInContainer ?? false,
	supportsBorderRadius: mod.supportsBorderRadius ?? false,
	focusOnInsert: mod.focusOnInsert ?? false,
});

// ---------------------------------------------------------------------------
// Third-party block registry (legacy API surface)
// ---------------------------------------------------------------------------

const thirdPartyRegistry = new Map<BlockType, BlockDefinition>();

/**
 * Register a third-party block definition. Built-in blocks should NOT use
 * this — they live as `EditorModule<T>` under
 * `packages/email-builder/src/blocks/<type>/`. Third-party / dynamic blocks
 * that don't have a type in `BlockType` still use this entry point.
 */
export function registerBlock(def: BlockDefinition): void {
	thirdPartyRegistry.set(def.type, def);
}

// ---------------------------------------------------------------------------
// Lookups — built-ins from Editor modules; third-party from the legacy map
// ---------------------------------------------------------------------------

export function getBlock(type: BlockType): BlockDefinition | undefined {
	// Third-party overrides built-ins (lets callers replace a built-in
	// definition in tests or custom builds).
	const thirdParty = thirdPartyRegistry.get(type);
	if (thirdParty) return thirdParty;

	const mod = editorModuleFor(type);
	return mod ? bridgeToDefinition(mod) : undefined;
}

/**
 * All block definitions. Pass `allowed` to restrict the result to a host-config
 * allowlist (`EmailBuilderConfig.blockTypes`); omit it for the default (all).
 */
export function getAllBlocks(allowed?: readonly BlockType[]): BlockDefinition[] {
	const builtIns = getAllEditorModules()
		.filter((m) => !thirdPartyRegistry.has(m.type))
		.map((m) => bridgeToDefinition(m));
	const thirdParty = [...thirdPartyRegistry.values()];
	const all = [...builtIns, ...thirdParty];
	if (!allowed) return all;
	const allowSet = new Set(allowed);
	return all.filter((d) => allowSet.has(d.type));
}

export function getBlockTypes(): BlockType[] {
	return getAllBlocks().map((d) => d.type);
}

export function getColumnItemTypes(): string[] {
	return getAllBlocks().filter((d) => d.canBeInColumn).map((d) => d.type);
}

export function getContainerItemTypes(): string[] {
	return getAllBlocks().filter((d) => d.canBeInContainer).map((d) => d.type);
}

export function getBorderRadiusTypes(): string[] {
	return getAllBlocks().filter((d) => d.supportsBorderRadius).map((d) => d.type);
}

export function getBlockLabels(): Record<string, string> {
	const labels: Record<string, string> = {};
	for (const def of getAllBlocks()) {
		labels[def.type] = def.label;
	}
	return labels;
}

/**
 * Slash commands for blocks that declare one. Pass `allowed` to restrict to a
 * host-config allowlist (`EmailBuilderConfig.blockTypes`); omit for all.
 */
export function getSlashCommands(allowed?: readonly BlockType[]): SlashCommand[] {
	return getAllBlocks(allowed)
		.filter((d) => d.slashCommand !== null)
		.map((d) => ({
			id: d.type,
			name: d.slashCommand!.name,
			description: d.slashCommand!.description,
			icon: d.slashCommand!.icon,
			category: d.slashCommand!.category,
			aliases: d.slashCommand!.aliases,
		}));
}
