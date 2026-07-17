/**
 * Host-mediated composition for hosted email blocks.
 *
 * An email block is a two-package vertical: a *renderer half* (a
 * `BlockRenderer` in `@owlat/email-renderer`, producing the block's HTML) and
 * an *editor half* (a `BlockDefinition` in `@owlat/email-builder`, carrying the
 * label, slash command, property panel and default factory). A plugin ships a
 * block only by contributing BOTH halves.
 *
 * `composeHostedEmailBlocks` is the single front door the platform host calls
 * at boot. It validates each contribution, orders it deterministically through
 * the host, registers both halves, and then FREEZES every block registry so the
 * post-boot silent-mutation window is closed. Registering a block after boot
 * therefore fails closed rather than mutating a live registry.
 *
 * Security / invariants enforced here:
 * - A renderer without a matching editor (or an editor without a matching
 *   renderer) is rejected — a plugin cannot ship half a block.
 * - A plugin cannot override a built-in block type.
 * - Two plugins cannot claim the same block type.
 * - Composition itself is rejected once the registries are frozen, so the host
 *   composes exactly once.
 */

import {
	registerBlock as registerRendererBlock,
	finalizeRegistry as finalizeRendererCustomRegistry,
	finalizeBlockRegistry as finalizeRendererModuleRegistry,
	isRegistryFinalized as isRendererCustomRegistryFrozen,
	registeredBlockTypes,
	type BlockRenderer,
} from '@owlat/email-renderer';
import { orderHostedContributions, type HostedContribution } from '@owlat/plugin-host';
import type { PluginId } from '@owlat/plugin-kit';
import {
	registerBlock as registerEditorBlock,
	finalizeBlockDefinitionRegistry,
	isBlockDefinitionRegistryFrozen,
	type BlockDefinition,
} from '../registry/blockRegistry';
import { finalizeEditorModuleRegistry, getRegisteredTypes } from '../blocks/_registry';

/** The renderer half of a hosted email block. */
export interface HostedEmailBlockRenderer {
	readonly type: string;
	readonly render: BlockRenderer;
}

/** The editor half of a hosted email block. */
export interface HostedEmailBlockEditor {
	readonly type: string;
	readonly definition: BlockDefinition;
}

/**
 * One plugin's email-block contribution: its renderer halves and its editor
 * halves. The host cross-checks that the two buckets describe the same set of
 * block types.
 */
export interface HostedEmailBlockContribution {
	readonly pluginId: PluginId;
	readonly renderers: readonly HostedEmailBlockRenderer[];
	readonly editors: readonly HostedEmailBlockEditor[];
}

/** A block that survived composition: both halves, owned by one plugin. */
export interface ComposedEmailBlock {
	readonly pluginId: PluginId;
	readonly type: string;
	readonly render: BlockRenderer;
	readonly definition: BlockDefinition;
}

export type EmailBlockCompositionErrorCode =
	| 'registries_frozen'
	| 'renderer_without_editor'
	| 'editor_without_renderer'
	| 'duplicate_block_type'
	| 'reserved_block_type'
	| 'unsupported_placement';

export class EmailBlockCompositionError extends Error {
	readonly code: EmailBlockCompositionErrorCode;
	readonly pluginId?: PluginId;
	readonly blockType?: string;

	constructor(
		code: EmailBlockCompositionErrorCode,
		message: string,
		details?: { pluginId?: PluginId; blockType?: string }
	) {
		super(message);
		this.name = 'EmailBlockCompositionError';
		this.code = code;
		this.pluginId = details?.pluginId;
		this.blockType = details?.blockType;
	}
}

/** Are all block registries frozen? True once the host has composed. */
export function areEmailBlockRegistriesFrozen(): boolean {
	return isRendererCustomRegistryFrozen() && isBlockDefinitionRegistryFrozen();
}

/**
 * Freeze every email-block registry: the renderer's module + custom-renderer
 * registries and the editor's module + third-party-definition registries.
 * These are the finalizers for the two block halves; the host calls this after
 * composition so no registry can be mutated once the app is running.
 */
export function finalizeEmailBlockRegistries(): void {
	// Renderer half.
	finalizeRendererModuleRegistry();
	finalizeRendererCustomRegistry();
	// Editor half.
	finalizeEditorModuleRegistry();
	finalizeBlockDefinitionRegistry();
}

/**
 * The set of block types a plugin may not claim: every type that already has a
 * built-in renderer module or editor module. Computed at call time so it always
 * reflects the shipped built-ins rather than a hand-maintained list.
 */
function reservedBlockTypes(): ReadonlySet<string> {
	const reserved = new Set<string>(registeredBlockTypes());
	for (const type of getRegisteredTypes()) reserved.add(type);
	return reserved;
}

/**
 * Pair a single plugin's renderer and editor halves by type, rejecting any
 * half that has no partner. Returns the paired blocks; throws on the first
 * defect so a malformed plugin cannot be partially registered.
 */
function pairContribution(
	contribution: HostedEmailBlockContribution,
	reserved: ReadonlySet<string>
): readonly ComposedEmailBlock[] {
	const { pluginId } = contribution;
	const renderers = new Map<string, BlockRenderer>();
	for (const half of contribution.renderers) {
		if (renderers.has(half.type)) {
			throw new EmailBlockCompositionError(
				'duplicate_block_type',
				`Plugin ${pluginId} contributes the "${half.type}" renderer more than once`,
				{ pluginId, blockType: half.type }
			);
		}
		renderers.set(half.type, half.render);
	}

	const editors = new Map<string, BlockDefinition>();
	for (const half of contribution.editors) {
		if (editors.has(half.type)) {
			throw new EmailBlockCompositionError(
				'duplicate_block_type',
				`Plugin ${pluginId} contributes the "${half.type}" editor more than once`,
				{ pluginId, blockType: half.type }
			);
		}
		if (half.definition.type !== half.type) {
			// A definition keyed under a different type would register the editor
			// half against the wrong block — that is an editor with no renderer for
			// its declared type.
			throw new EmailBlockCompositionError(
				'editor_without_renderer',
				`Plugin ${pluginId} editor for "${half.type}" declares a mismatched definition type "${half.definition.type}"`,
				{ pluginId, blockType: half.type }
			);
		}
		if (half.definition.canBeInColumn || half.definition.canBeInContainer) {
			// A hosted block's renderer half goes through the renderer's legacy
			// custom registry, which the renderer only consults at ROOT placement
			// (renderColumnItem / renderContainerItem dispatch solely through the
			// Block-module registry and drop unknown types). Accepting an editor
			// half that advertises column/container placement would let the builder
			// offer the block inside a column while the rendered email silently
			// omits it — content loss with no error. Reject at the front door.
			throw new EmailBlockCompositionError(
				'unsupported_placement',
				`Plugin ${pluginId} editor for "${half.type}" sets canBeInColumn/canBeInContainer, but hosted blocks render only at root placement`,
				{ pluginId, blockType: half.type }
			);
		}
		editors.set(half.type, half.definition);
	}

	const composed: ComposedEmailBlock[] = [];
	for (const [type, render] of renderers) {
		if (reserved.has(type)) {
			throw new EmailBlockCompositionError(
				'reserved_block_type',
				`Plugin ${pluginId} cannot override built-in block type "${type}"`,
				{ pluginId, blockType: type }
			);
		}
		const definition = editors.get(type);
		if (!definition) {
			throw new EmailBlockCompositionError(
				'renderer_without_editor',
				`Plugin ${pluginId} contributes a renderer for "${type}" but no editor half`,
				{ pluginId, blockType: type }
			);
		}
		composed.push({ pluginId, type, render, definition });
	}

	for (const type of editors.keys()) {
		if (!renderers.has(type)) {
			throw new EmailBlockCompositionError(
				'editor_without_renderer',
				`Plugin ${pluginId} contributes an editor for "${type}" but no renderer half`,
				{ pluginId, blockType: type }
			);
		}
	}

	return composed;
}

/**
 * Compose the bundled plugins' email blocks through the host, register both
 * halves of each surviving block, then freeze every block registry.
 *
 * Called once at host boot. Passing an empty list still freezes the registries,
 * which is the point: a deployment with no plugin blocks still latches the
 * built-in registries shut after boot.
 */
export function composeHostedEmailBlocks(
	contributions: readonly HostedEmailBlockContribution[]
): readonly ComposedEmailBlock[] {
	if (areEmailBlockRegistriesFrozen()) {
		throw new EmailBlockCompositionError(
			'registries_frozen',
			'Email block registries are already frozen; the host composes email blocks exactly once at boot'
		);
	}

	const reserved = reservedBlockTypes();

	// Pair each plugin's halves, then order the whole set deterministically via
	// the host before any registration happens.
	const hosted: HostedContribution<ComposedEmailBlock>[] = [];
	const claimedTypes = new Map<string, PluginId>();
	for (const contribution of contributions) {
		for (const block of pairContribution(contribution, reserved)) {
			const owner = claimedTypes.get(block.type);
			if (owner) {
				throw new EmailBlockCompositionError(
					'duplicate_block_type',
					`Block type "${block.type}" is claimed by both ${owner} and ${block.pluginId}`,
					{ pluginId: block.pluginId, blockType: block.type }
				);
			}
			claimedTypes.set(block.type, block.pluginId);
			hosted.push({
				pluginId: block.pluginId,
				contributionId: block.type,
				value: block,
			});
		}
	}

	const ordered = orderHostedContributions(hosted).map((entry) => entry.value);

	for (const block of ordered) {
		registerRendererBlock(block.type, block.render);
		registerEditorBlock(block.definition);
	}

	finalizeEmailBlockRegistries();

	return Object.freeze(ordered);
}
