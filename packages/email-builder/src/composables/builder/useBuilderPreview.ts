import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import type { EditorBlock, EmailTheme, Variable, VariableType } from '../../types';
import type { PreviewRenderOptions } from '../../preview/types';
import { fillPreviewVariables } from '../../utils/variables';
import { usePreview } from '../usePreview';

interface UseBuilderPreviewOptions {
	canvasBlocks: Ref<EditorBlock[]>;
	blocksVersion: Ref<number>;
	formSubject: Ref<string>;
	theme: ComputedRef<Required<EmailTheme>>;
	variableType: ComputedRef<VariableType>;
	showMandatoryUnsubscribeFooter: ComputedRef<boolean>;
	variables: ComputedRef<Variable[]>;
}

/**
 * The builder's preview: the rendered email and everything the previewer
 * shows about it, re-rendered while a preview is open.
 */
export function useBuilderPreview({
	canvasBlocks,
	blocksVersion,
	formSubject,
	theme,
	variableType,
	showMandatoryUnsubscribeFooter,
	variables,
}: UseBuilderPreviewOptions) {
	// Preview — driven entirely by usePreview, which wires the renderer's HTML /
	// plain-text / AMP / analysis / diff generation through the user-controllable
	// render options (base width, direction, custom CSS, web fonts, preheader,
	// title, variables, minify, CSS inlining, …). The RenderOptionsPanel in the
	// previewer emits update:render-options; we own the backing ref so every
	// control actually re-renders the preview.
	const renderOptions = ref<Partial<PreviewRenderOptions>>({});

	const preview = usePreview({
		canvasBlocks,
		theme,
		variableType,
		showMandatoryUnsubscribeFooter,
		renderOptions,
		variables,
	});
	const { previewMode, previewDarkMode, regenerate, regenerateHtml } = preview;

	// The preview fills the subject's tokens the way it fills the body's, so the
	// inbox line reads "Alex invited you" instead of "{{inviterName}} invited you".
	const previewSubject = computed(() =>
		fillPreviewVariables(formSubject.value, {
			values: renderOptions.value.variableValues ?? {},
			labels: Object.fromEntries(variables.value.map((v) => [v.key, v.label])),
		})
	);

	// Keep the live editing reactivity the canvas had before: while a non-edit
	// preview is open, re-render the moment the blocks change.
	watch(blocksVersion, () => {
		if (previewMode.value !== 'edit') regenerate();
	});

	// Dark-mode toggle from the previewer re-renders the HTML against the new mode;
	// plain text, AMP and Block validation do not depend on it.
	function handlePreviewDarkMode(value: boolean) {
		previewDarkMode.value = value;
		if (previewMode.value !== 'edit') regenerateHtml();
	}

	return {
		renderOptions,
		previewMode,
		previewDarkMode,
		previewHtml: preview.generatedHtml,
		isGeneratingHtml: preview.isGeneratingHtml,
		previewPlainText: preview.plainText,
		previewPlainTextSource: preview.plainTextSource,
		previewAmpHtml: preview.ampHtml,
		previewAmpRequested: preview.ampRequested,
		previewRenderWarnings: preview.renderWarnings,
		previewEmailAnalysis: preview.emailAnalysis,
		previewHealthScore: preview.healthScore,
		previewValidationIssues: preview.validationIssues,
		previewEmailDiff: preview.emailDiff,
		previewDiffRequested: preview.diffRequested,
		previewHtmlChanged: preview.htmlChanged,
		togglePreviewMode: preview.togglePreviewMode,
		previewSubject,
		handlePreviewDarkMode,
	};
}
