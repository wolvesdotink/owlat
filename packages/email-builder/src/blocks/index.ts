/**
 * Editor module barrel. Importing this file registers every built-in block
 * and re-exports the typed registry helpers.
 */

import './_builtin-modules';

export type {
	EditorModule,
	EditorModuleMap,
	NestedChild,
	SlashCommandMeta,
	BlockOf,
} from './_module';
export {
	registerEditorModule,
	editorModuleFor,
	getAllEditorModules,
	getRegisteredTypes,
	finalizeEditorModuleRegistry,
	isEditorModuleRegistryFrozen,
} from './_registry';
