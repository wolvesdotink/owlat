<script setup lang="ts">
/**
 * EmailBuilder — Notion-like inline document editor.
 *
 * Architecture:
 * - Single centered column (DocumentCanvas) with direct DOM previews
 * - BlockInsertToolbar: horizontal icon strip for quick block insertion
 * - SubjectFields: inline subject + name above canvas
 * - UnifiedToolbar: combined floating toolbar (formatting + settings)
 *
 * The editing logic is wired in `useEmailBuilder` from the composables in
 * `composables/builder/`; this component renders it.
 */
import { ref, computed } from 'vue';
// The builder's keyframes and variable-chip style load with the builder chunk,
// not with every page of the host app.
import '../styles/utilities.css';
import {
	useEmailBuilder,
	type EmailBuilderProps,
	type EmailBuilderEmits,
} from '../composables/builder/useEmailBuilder';

// Components
import EditorHeader from './EditorHeader.vue';
import FocusModeOverlay from './FocusModeOverlay.vue';
import PreviewPanel from './PreviewPanel.vue';
import DocumentCanvas from './canvas/DocumentCanvas.vue';
import FloatingBlockSidebar from './canvas/FloatingBlockSidebar.vue';
import SubjectFields from './canvas/SubjectFields.vue';
import UnifiedToolbar from './canvas/UnifiedToolbar.vue';
import {
	SaveBlockModal,
	UnsavedChangesDialog,
	LinkDialog,
	VariableCreateDialog,
	KeyboardShortcutsDialog,
} from './dialogs';
import SavedBlockPickerMenu from './canvas/SavedBlockPickerMenu.vue';
import UiConfirmationDialog from '@owlat/ui/components/ui/ConfirmationDialog.vue';
import { useBuilderI18n } from '../i18n/useBuilderI18n';

const { t } = useBuilderI18n();

const props = defineProps<EmailBuilderProps>();
const emit = defineEmits<EmailBuilderEmits>();

const {
	canvasBlocks,
	formName,
	formSubject,
	emailBackgroundColor,
	theme,
	showDataVariables,
	showVariableDialog,
	variableDialogKey,
	existingVariableKeys,
	openVariableDialog,
	handleVariableCreate,
	hideSubject,
	allowedBlockTypes,
	selectedBlockId,
	selectedNestedItemId,
	activeBlock,
	activeBlockElement,
	activeBlockSchema,
	isActiveBlockLinked,
	activeLinkedBlockName,
	selectRoot,
	handleSelectNested,
	clearSelection,
	selectBlock,
	showDetachConfirm,
	pendingDetachBlockName,
	confirmDetach,
	cancelDetach,
	handleDetachActiveBlock,
	canUndo,
	canRedo,
	undo,
	redo,
	isBrandConfigured,
	insertableBrandBlocks,
	showApplyBrandConfirm,
	applyBrandDescription,
	confirmApplyBrand,
	insertBrandBlocks,
	isFocusMode,
	toggleFocusMode,
	exitFocusMode,
	showFocusHint,
	handleToolbarUpdate,
	handleToolbarDelete,
	handleToolbarDuplicate,
	handleSelectChild,
	handleAddChild,
	handleRemoveChild,
	handleUpdateChildren,
	handleReorderChildren,
	isInlineEditing,
	inlineEditBlockId,
	showLinkDialog,
	linkDialogInitialUrl,
	linkDialogIsEditing,
	exitInlineEdit,
	handleInlineFormat,
	handleLinkApply,
	handleLinkRemove,
	closeLinkDialog,
	loadState,
	applyRemoteOps,
	savedBlockPickerState,
	closeSavedBlockPicker,
	handleSavedBlockSelect,
	showSaveBlockModal,
	saveBlockName,
	isSavingBlock,
	openSaveBlockModal,
	closeSaveBlockModal,
	saveAsReusableBlock,
	canSaveAsBlock,
	showShortcutsDialog,
	renderOptions,
	previewMode,
	previewDarkMode,
	previewHtml,
	isGeneratingHtml,
	previewPlainText,
	previewPlainTextSource,
	previewAmpHtml,
	previewAmpRequested,
	previewRenderWarnings,
	previewEmailAnalysis,
	previewHealthScore,
	previewValidationIssues,
	previewEmailDiff,
	previewDiffRequested,
	previewHtmlChanged,
	togglePreviewMode,
	previewSubject,
	handlePreviewDarkMode,
	handleDoubleClickBlock,
	handleExitInlineEdit,
	handleAddTextBlockFromPlaceholder,
	handleInsertBlockAfter,
	handleOpenLinkDialog,
	handlePasteImage,
	handlePasteRichContent,
	handleAddBlockFromToolbar,
	handleInsertBlockAt,
	handleSlashCommandSelect,
} = useEmailBuilder(props, emit);

// `isInlineEditing` tells a host that text may be typed which the blocks do not
// hold yet (the inline editor commits when it closes), so replacing the canvas
// now would leave that text to be committed on top of whatever replaced it.
// `commitInlineEdit` closes that editor, so a host about to save (or leave)
// can have the text in the blocks first.
defineExpose({
	loadState,
	applyRemoteOps,
	isInlineEditing,
	selectBlock,
	commitInlineEdit: exitInlineEdit,
});

// Canvas ref for sidebar positioning
const documentCanvasRef = ref<InstanceType<typeof DocumentCanvas> | null>(null);
const canvasInnerElement = computed(
	() => (documentCanvasRef.value?.canvasInnerElement ?? null) as HTMLElement | null
);
</script>

<template>
	<div class="light flex flex-col h-full bg-bg-base">
		<!-- Header -->
		<div
			class="shrink-0 overflow-hidden transition-[max-height,opacity] duration-(--motion-moderate) ease-spring max-h-20"
			:class="{ '!max-h-0 !opacity-0 !pointer-events-none': isFocusMode }"
		>
			<EditorHeader
				:name="formName"
				:subject="formSubject"
				:preview-mode="previewMode"
				:is-focus-mode="isFocusMode"
				:is-saving="isSaving ?? false"
				:is-generating-html="isGeneratingHtml"
				:hide-subject="true"
				:config="config"
				:can-undo="canUndo"
				:can-redo="canRedo"
				:can-apply-brand="isBrandConfigured"
				@update:name="formName = $event"
				@update:subject="formSubject = $event"
				@toggle-preview="togglePreviewMode"
				@toggle-focus-mode="toggleFocusMode"
				@save="emit('save')"
				@back="emit('back')"
				@settings="emit('settings')"
				@undo="undo"
				@redo="redo"
				@show-shortcuts="showShortcutsDialog = true"
				@apply-brand="showApplyBrandConfirm = true"
			>
				<template v-if="$slots['toolbar-actions']" #toolbar-actions>
					<slot name="toolbar-actions" />
				</template>
				<template v-if="$slots['save-status']" #save-status>
					<slot name="save-status" />
				</template>
			</EditorHeader>
		</div>

		<!-- Focus mode overlay -->
		<FocusModeOverlay
			v-if="isFocusMode"
			:is-focus-mode="isFocusMode"
			:show-hint="showFocusHint"
			:is-saving="isSaving ?? false"
			@exit="exitFocusMode"
		/>

		<!-- Main editor area: single column document canvas -->
		<div v-if="previewMode === 'edit'" class="flex-1 overflow-hidden flex">
			<DocumentCanvas
				ref="documentCanvasRef"
				:blocks="canvasBlocks"
				:selected-block-id="selectedBlockId"
				:selected-nested-item-id="selectedNestedItemId"
				:theme="theme"
				:background-color="emailBackgroundColor"
				:inline-edit-block-id="inlineEditBlockId"
				:variables="variables"
				:block-types="allowedBlockTypes"
				:remote-marks="remoteMarks"
				@update:blocks="canvasBlocks = $event"
				@select="selectRoot"
				@select-nested="handleSelectNested"
				@clear-selection="clearSelection"
				@update-children="handleUpdateChildren"
				@double-click-block="handleDoubleClickBlock"
				@exit-inline-edit="handleExitInlineEdit"
				@slash-command-select="handleSlashCommandSelect"
				@add-text-block="handleAddTextBlockFromPlaceholder"
				@insert-block-after="handleInsertBlockAfter"
				@open-link-dialog="handleOpenLinkDialog"
				@paste-image="handlePasteImage"
				@paste-rich-content="handlePasteRichContent"
				@insert-block-at="handleInsertBlockAt"
				@update:background-color="emailBackgroundColor = $event"
			>
				<!-- Subject fields slot -->
				<template #subject-fields>
					<SubjectFields
						:name="formName"
						:subject="formSubject"
						:hide-subject="hideSubject"
						:mode="config?.mode"
						:variables="variables"
						:show-data-variables="showDataVariables"
						:data-variables="variables"
						@update:name="formName = $event"
						@update:subject="formSubject = $event"
						@add-variable="openVariableDialog"
					/>
				</template>

				<!-- Forward after-canvas slot -->
				<template v-if="$slots['after-canvas']" #after-canvas>
					<slot name="after-canvas" />
				</template>
			</DocumentCanvas>

			<!-- Floating block sidebar (left of canvas) -->
			<FloatingBlockSidebar
				v-if="!isFocusMode"
				:canvas-element="canvasInnerElement"
				:visible="true"
				:block-types="allowedBlockTypes"
				:brand-blocks="insertableBrandBlocks"
				@add-block="handleAddBlockFromToolbar"
				@add-brand-block="insertBrandBlocks"
			/>
		</div>

		<!-- Unified toolbar (format bar + settings popover combined) -->
		<UnifiedToolbar
			v-if="activeBlock && activeBlockElement && activeBlockSchema"
			:block="activeBlock"
			:anchor-element="activeBlockElement"
			:schema="activeBlockSchema"
			:is-inline-editing="isInlineEditing"
			:variables="variables"
			:theme="theme"
			:is-linked="isActiveBlockLinked"
			:linked-block-name="activeLinkedBlockName"
			:can-save-as-block="canSaveAsBlock && !!selectedBlockId"
			@update="handleToolbarUpdate"
			@format="handleInlineFormat"
			@delete="handleToolbarDelete"
			@duplicate="handleToolbarDuplicate"
			@detach="handleDetachActiveBlock"
			@save-block="openSaveBlockModal"
			@select-child="handleSelectChild"
			@add-child="handleAddChild"
			@remove-child="handleRemoveChild"
			@reorder-children="handleReorderChildren"
		/>

		<!-- Preview mode -->
		<div v-if="previewMode !== 'edit'" class="flex-1 overflow-hidden">
			<PreviewPanel
				:html="previewHtml"
				:subject="previewSubject"
				:is-generating="isGeneratingHtml"
				:dark-mode="previewDarkMode"
				:plain-text="previewPlainText"
				:plain-text-source="previewPlainTextSource"
				:plain-text-override="props.plainTextOverride ?? ''"
				:allow-plain-text-override="props.allowPlainTextOverride ?? false"
				:amp-html="previewAmpHtml"
				amp-available
				:render-warnings="previewRenderWarnings"
				:email-analysis="previewEmailAnalysis"
				:health-score="previewHealthScore"
				:validation-issues="previewValidationIssues"
				:email-diff="previewEmailDiff"
				:diff-available="previewHtmlChanged"
				:render-options="renderOptions"
				@update:render-options="renderOptions = $event"
				@update:dark-mode="handlePreviewDarkMode"
				@update:amp-requested="previewAmpRequested = $event"
				@update:diff-requested="previewDiffRequested = $event"
				@send-test="emit('send-test', previewHtml)"
				@update:plain-text-override="emit('update:plainTextOverride', $event)"
			/>
		</div>

		<!-- Link dialog -->
		<LinkDialog
			v-if="showLinkDialog"
			:initial-url="linkDialogInitialUrl"
			:is-editing="linkDialogIsEditing"
			@apply="handleLinkApply"
			@remove="handleLinkRemove"
			@close="closeLinkDialog"
		/>

		<!-- Saved block picker -->
		<SavedBlockPickerMenu
			v-if="savedBlockPickerState.isOpen"
			:blocks="savedBlockPickerState.blocks"
			:is-loading="savedBlockPickerState.isLoading"
			:position="savedBlockPickerState.position"
			@select="handleSavedBlockSelect"
			@close="closeSavedBlockPicker"
		/>

		<!-- Save as reusable block dialog — captures the selected block into the
		     reusable-block library via the host-wired savedBlocks.save handler. -->
		<SaveBlockModal
			:show="showSaveBlockModal"
			:block-name="saveBlockName"
			:is-saving="isSavingBlock"
			@update:block-name="saveBlockName = $event"
			@save="saveAsReusableBlock"
			@close="closeSaveBlockModal"
		/>

		<!-- Add data variable dialog — the in-editor affordance to define a new
		     data variable. Emits create-variable so the host page persists it. -->
		<VariableCreateDialog
			:show="showVariableDialog"
			:initial-key="variableDialogKey"
			:existing-keys="existingVariableKeys"
			@create="handleVariableCreate"
			@close="showVariableDialog = false"
		/>

		<!-- Keyboard shortcuts help sheet -->
		<KeyboardShortcutsDialog :show="showShortcutsDialog" @close="showShortcutsDialog = false" />

		<!-- Apply brand kit: restyles the whole email, so it asks first -->
		<UiConfirmationDialog
			:open="showApplyBrandConfirm"
			:title="t('builder.brand.applyTitle')"
			:description="applyBrandDescription"
			:confirm-text="t('builder.brand.apply')"
			:cancel-text="t('builder.common.cancel')"
			@confirm="confirmApplyBrand"
			@cancel="showApplyBrandConfirm = false"
			@update:open="!$event && (showApplyBrandConfirm = false)"
		/>

		<!-- Detach confirmation dialog -->
		<UiConfirmationDialog
			:open="showDetachConfirm"
			:title="t('builder.detach.title')"
			:description="
				t('builder.detach.description', {
					block: pendingDetachBlockName || t('builder.detach.thisBlock'),
				})
			"
			:confirm-text="t('builder.detach.confirm')"
			:cancel-text="t('builder.common.cancel')"
			variant="warning"
			@confirm="confirmDetach"
			@cancel="cancelDetach"
			@update:open="!$event && cancelDetach()"
		/>
	</div>
</template>
