export { generateId } from './id';
export { computeButtonTextColor, RecentColorsManager } from './colors';
export {
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
	regenerateContainerItemIds,
	regenerateColumnItemIds,
	regenerateNestedBlockIds,
} from './blocks';
export {
	type HistoryCheckpoint,
	type HistoryDelta,
	type HistoryEntry,
	generatePatches,
	applyPatches,
	shouldCreateCheckpoint,
	reconstructState,
} from './deltaHistory';
export {
	type VersionSnapshotPayload,
	serializeHistoryState,
	deserializeVersionSnapshot,
	parseSnapshotBlocks,
	snapshotMatchesState,
	formatSnapshotSize,
} from './versionSnapshot';
export {
	containsVariable,
	extractVariableName,
	extractVariableNames,
	fillPreviewVariables,
} from './variables';
export { blockAccessibleLabel, blockContentExcerpt } from './blockLabel';
export { getByPath, setByPath } from './propertyPath';
export { gradientCss } from './gradient';
export {
	type ConditionOperator,
	conditionOperatorOptions,
	conditionNeedsValue,
	normalizeCondition,
	DEFAULT_CONDITION_OPERATOR,
} from './blockCondition';
