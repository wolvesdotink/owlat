// Components
export {
	EmailBuilder,
	DocumentCanvas,
	DocumentBlock,
	BlockInsertToolbar,
	UnifiedToolbar,
	DragHandle,
	BlockPlaceholder,
	SubjectFields,
	InlineTextEditor,
} from './components';

// Composables
export {
	provideEmailBuilderHandlers,
	useEmailBuilderHandlers,
	EmailBuilderHandlersKey,
	useFocusMode,
	useHistory,
} from './composables';

// Dialogs
export { UnsavedChangesDialog } from './components/dialogs';

// Types
export type {
	// Block types
	BlockType,
	UniversalPadding,
	UniversalMargin,
	BorderStyle,
	UniversalBorder,
	TextBlockContent,
	ImageBlockContent,
	ButtonBlockContent,
	DividerBlockContent,
	SpacerBlockContent,
	ColumnItem,
	ColumnRatio,
	ColumnStyle,
	ColumnsBlockContent,
	ContainerItemType,
	ContainerItemContent,
	ContainerItem,
	ContainerBlockContent,
	SocialPlatform,
	SocialLink,
	SocialBlockContent,
	HeroBlockContent,
	TableBlockContent,
	RawHtmlBlockContent,
	VideoBlockContent,
	BlockContent,
	SavedBlockRef,
	EditorBlock,
	SavedBlock,
	// Variable types
	Variable,
	VariableType,
	// Editor types
	EmailTheme,
	EmailBuilderMode,
	EmailBuilderConfig,
	ImageUploadResult,
	EmailBuilderHandlers,
	EmailBuilderProps,
	EmailBuilderEmits,
	PreviewDevice,
	PreviewMode,
	SlashCommand,
	SlashMenuState,
} from './types';

// Utilities
export {
	generateId,
	computeButtonTextColor,
	RecentColorsManager,
	createDefaultContent,
	createDefaultColumnItemContent,
	createBlock,
	createColumnItem,
	getBlockPadding,
	updateBlockPadding,
	toggleLinkedPadding,
	getBlockMargin,
	updateBlockMargin,
	getBlockBackgroundColor,
	updateBlockBackgroundColor,
	blockSupportsBorderRadius,
	getBlockBorderRadius,
	updateBlockBorderRadius,
	getColumnWidths,
} from './utils';

// Defaults
export {
	defaultPadding,
	defaultMargin,
	defaultBackgroundColor,
	defaultBorderRadius,
	defaultTheme,
} from './defaults';

// Registry — legacy BlockDefinition API plus the new typed Editor module API.
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
	finalizeBlockDefinitionRegistry,
	isBlockDefinitionRegistryFrozen,
	type EditorModule,
	type EditorModuleMap,
	type NestedChild,
	registerEditorModule,
	editorModuleFor,
	getAllEditorModules,
	getRegisteredTypes,
	finalizeEditorModuleRegistry,
	isEditorModuleRegistryFrozen,
} from './registry';

// Schema
export {
	type BlockAttributeSchema,
	type PropertyGroup,
	type PropertyField,
	type FieldType,
	registerSchema,
	getSchema,
	getAllSchemas,
	getToolbarFields,
} from './schema';

// Host-mediated email-block composition.
export {
	composeHostedEmailBlocks,
	finalizeEmailBlockRegistries,
	areEmailBlockRegistriesFrozen,
	EmailBlockCompositionError,
	type HostedEmailBlockContribution,
	type HostedEmailBlockRenderer,
	type HostedEmailBlockEditor,
	type ComposedEmailBlock,
	type EmailBlockCompositionErrorCode,
} from './host/emailBlockHost';
