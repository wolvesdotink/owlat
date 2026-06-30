// Side effect: registers all 17 built-in Editor modules. Each
// `packages/email-builder/src/blocks/<type>/` exports an `EditorModule<T>`;
// the barrel registers them with the typed registry. The legacy
// `BlockDefinition` API exported below is now a thin bridge over that
// registry — see `blockRegistry.ts` and `docs/adr/0001-block-module-deepening.md`.
import '../blocks';

export {
	type BlockDefinition,
	registerBlock,
	getBlock,
	getAllBlocks,
	getBlockTypes,
	getColumnItemTypes,
	getContainerItemTypes,
	getBorderRadiusTypes,
	getBlockLabels,
	getSlashCommands,
} from './blockRegistry';

// New typed Editor module API. Prefer these for new code; the legacy
// `BlockDefinition` exports above remain for back-compat with existing
// consumers (DocumentCanvas, BlockInsertToolbar, slash-command derivation).
export {
	type EditorModule,
	type EditorModuleMap,
	type NestedChild,
	registerEditorModule,
	editorModuleFor,
	getAllEditorModules,
	getRegisteredTypes,
} from '../blocks';
