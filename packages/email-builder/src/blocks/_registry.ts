/**
 * Typed Editor module registry. Authors register their module via
 * `registerEditorModule(mod)`; consumers look up by type via
 * `editorModuleFor(type)`. The registry is the single dispatch point for
 * every cross-cutting builder surface (panel, canvas, slash menu, nested-
 * items, slash-command derivation, capability queries).
 *
 * Module files self-register at import time (side-effect imports). The
 * `_builtin-modules.ts` barrel imports all 18 built-in types and is itself
 * imported once from the package entry point.
 */

import type { BlockType } from '../types';
import type { EditorModule } from './_module';
import { createFreezeLatch } from '../registry/freezeLatch';

const registry = new Map<BlockType, EditorModule<BlockType>>();
const latch = createFreezeLatch({
	noun: 'editor module',
	registryName: 'editor module registry',
	plural: 'modules',
	finalizeFn: 'finalizeEditorModuleRegistry',
});

/**
 * Register an Editor module. Idempotent: re-registration overwrites.
 *
 * Must be called before `finalizeEditorModuleRegistry()`. Built-in modules
 * self-register at import time; the host freezes the registry after
 * composition, so registration attempts after that point fail closed rather
 * than silently mutating a live registry.
 */
export function registerEditorModule<T extends BlockType>(mod: EditorModule<T>): void {
	latch.assertMutable(mod.type);
	registry.set(mod.type, mod as unknown as EditorModule<BlockType>);
}

/** Freeze the editor module registry to prevent further mutation. */
export function finalizeEditorModuleRegistry(): void {
	latch.finalize();
}

/** Is the editor module registry currently frozen? */
export function isEditorModuleRegistryFrozen(): boolean {
	return latch.isFrozen();
}

/** Look up the Editor module for a block type. Returns undefined if absent. */
export function editorModuleFor<T extends BlockType>(type: T): EditorModule<T> | undefined {
	return registry.get(type) as EditorModule<T> | undefined;
}

/** All registered editor modules, in registration order. */
export function getAllEditorModules(): EditorModule<BlockType>[] {
	return [...registry.values()];
}

/** All registered block types. */
export function getRegisteredTypes(): BlockType[] {
	return [...registry.keys()];
}
