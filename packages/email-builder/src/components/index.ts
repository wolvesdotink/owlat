// Main email builder component
export { default as EmailBuilder } from './EmailBuilder.vue';

export { default as PreviewPanel } from './PreviewPanel.vue';
export { default as EditorHeader } from './EditorHeader.vue';
export { default as FocusModeOverlay } from './FocusModeOverlay.vue';

// New document-style canvas components
export { default as DocumentCanvas } from './canvas/DocumentCanvas.vue';
export { default as DocumentBlock } from './canvas/DocumentBlock.vue';
export { default as BlockInsertToolbar } from './canvas/BlockInsertToolbar.vue';
export { default as UnifiedToolbar } from './canvas/UnifiedToolbar.vue';
export { default as DragHandle } from './canvas/DragHandle.vue';
export { default as BlockPlaceholder } from './canvas/BlockPlaceholder.vue';
export { default as SubjectFields } from './canvas/SubjectFields.vue';

// InlineTextEditor is exported because it's planned for refactor (Stage 5);
// remaining canvas/panel components are internal to EmailBuilder.
export { default as InlineTextEditor } from './canvas/InlineTextEditor.vue';

// Dialogs
export * from './dialogs';
