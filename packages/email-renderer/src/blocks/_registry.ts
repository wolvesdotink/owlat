/**
 * Block module registry. Built-in Block modules register here at package init
 * via `registerBlockModule()`; host applications can add custom modules before
 * `finalizeBlockRegistry()` freezes the registry.
 *
 * The Walker (see ./index.ts) looks up by type and dispatches when a module is
 * registered, falling back to the legacy switch otherwise. This is the hybrid
 * dispatch path used during migration.
 */

import type { BlockType } from '@owlat/shared';
import type { BlockModule } from './_module';
import { registerBlockValidator } from '../validators/registry';

const registry = new Map<string, BlockModule<BlockType>>();
let frozen = false;

/**
 * Register a Block module. The discriminator generic ensures a button module
 * cannot be registered under the 'text' key.
 *
 * If the module declares a `validate` method, this also bridges it into the
 * legacy `blockValidators` registry so the existing `validateBlocks()` from
 * `email-renderer/validator.ts` orchestrator picks it up automatically.
 *
 * Must be called before `finalizeBlockRegistry()`.
 */
export const registerBlockModule = <T extends BlockType>(mod: BlockModule<T>): void => {
	if (frozen) {
		throw new Error(`Cannot register block "${mod.type}": registry is frozen. Call registerBlockModule() during setup before finalizeBlockRegistry().`);
	}
	registry.set(mod.type, mod as unknown as BlockModule<BlockType>);

	if (mod.validate) {
		const validateFn = mod.validate;
		registerBlockValidator({
			type: mod.type,
			validate: (block, ctx) => {
				validateFn({ block: block as never, content: block.content as never, ctx });
			},
		});
	}
};

/**
 * Unregister a Block module. Returns true if anything was removed.
 * Must be called before `finalizeBlockRegistry()`.
 */
export const unregisterBlockModule = (type: string): boolean => {
	if (frozen) {
		throw new Error(`Cannot unregister block "${type}": registry is frozen.`);
	}
	return registry.delete(type);
};

/** Freeze the registry to prevent further mutation. */
export const finalizeBlockRegistry = (): void => {
	frozen = true;
};

/** Is the registry currently frozen? */
export const isBlockRegistryFrozen = (): boolean => frozen;

/**
 * Look up a Block module by type tag, preserving discriminated-union narrowing
 * for built-in types.
 */
export const moduleFor = <T extends BlockType>(type: T): BlockModule<T> | undefined =>
	registry.get(type) as BlockModule<T> | undefined;

/** List all currently registered block types (built-in + custom). */
export const registeredBlockTypes = (): readonly string[] =>
	Array.from(registry.keys());
