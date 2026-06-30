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

const registry = new Map<BlockType, EditorModule<BlockType>>();

/** Register an Editor module. Idempotent: re-registration overwrites. */
export function registerEditorModule<T extends BlockType>(mod: EditorModule<T>): void {
	registry.set(mod.type, mod as unknown as EditorModule<BlockType>);
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
