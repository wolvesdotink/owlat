import { describe, it, expect } from 'vitest';
import { ref, computed, nextTick } from 'vue';
import { usePreview, type PreviewRenderOptions } from '../usePreview';
import { defaultTheme } from '../../defaults';
import type { EditorBlock, VariableType } from '../../types';

/**
 * Behavioural tests for `usePreview` — the composable that drives the editor's
 * Preview mode. It was previously exported but had zero callers, so none of its
 * wiring was exercised. EmailBuilder now owns a `renderOptions` ref and consumes
 * this composable, so these tests pin the contract the editor relies on:
 *
 *  - entering preview generates HTML, plain text, AMP and analysis together,
 *  - the render options (custom CSS, base width, …) actually flow into the
 *    regenerated output while a preview is open (the core gap that was broken),
 *  - leaving and re-entering preview keeps everything consistent.
 */

function textBlock(id: string, html: string): EditorBlock {
	return {
		id,
		type: 'text',
		content: { html, blockType: 'paragraph', fontSize: 16, textColor: '#111111' },
	};
}

function setup(renderOptions = ref<Partial<PreviewRenderOptions>>({})) {
	const canvasBlocks = ref<EditorBlock[]>([textBlock('a', 'Hello preview world')]);
	const preview = usePreview({
		canvasBlocks,
		theme: computed(() => defaultTheme),
		variableType: computed<VariableType>(() => 'personalization'),
		showMandatoryUnsubscribeFooter: computed(() => false),
		renderOptions,
	});
	return { canvasBlocks, renderOptions, preview };
}

describe('usePreview', () => {
	it('starts in edit mode with empty derived artifacts', () => {
		const { preview } = setup();
		expect(preview.previewMode.value).toBe('edit');
		expect(preview.generatedHtml.value).toBe('');
		expect(preview.plainText.value).toBe('');
		expect(preview.ampHtml.value).toBe('');
		expect(preview.emailAnalysis.value).toBeNull();
	});

	it('generates html, plain text, AMP and analysis when entering preview', () => {
		const { preview } = setup();
		preview.togglePreviewMode();

		expect(preview.previewMode.value).toBe('preview');
		expect(preview.generatedHtml.value).toContain('Hello preview world');
		// Plain-text view is no longer permanently empty.
		expect(preview.plainText.value).toContain('Hello preview world');
		// AMP tab now has content to render.
		expect(preview.ampHtml.value).toContain('⚡4email');
		// HTML-compatibility analysis populates (drives the Size sub-tab).
		expect(preview.emailAnalysis.value).not.toBeNull();
		expect(preview.emailAnalysis.value?.htmlSizeBytes).toBeGreaterThan(0);
	});

	it('flows render options into the regenerated preview', async () => {
		const { renderOptions, preview } = setup();
		preview.togglePreviewMode();
		expect(preview.generatedHtml.value).not.toContain('owlat-render-options-marker');

		renderOptions.value = { customCss: '.owlat-render-options-marker { color: red }' };
		await nextTick();

		// The render-options watch re-renders, so the control is no longer a no-op.
		expect(preview.generatedHtml.value).toContain('owlat-render-options-marker');
	});

	it('honours the title render option in the generated head', async () => {
		const { renderOptions, preview } = setup();
		preview.togglePreviewMode();

		renderOptions.value = { title: 'My Custom Title' };
		await nextTick();

		expect(preview.generatedHtml.value).toContain('My Custom Title');
	});

	it('re-renders the open preview when blocks would change via regenerate()', () => {
		const { canvasBlocks, preview } = setup();
		preview.togglePreviewMode();
		expect(preview.generatedHtml.value).toContain('Hello preview world');

		canvasBlocks.value = [textBlock('a', 'Edited body copy')];
		preview.regenerate();

		expect(preview.generatedHtml.value).toContain('Edited body copy');
		expect(preview.plainText.value).toContain('Edited body copy');
	});

	it('fills {{variables}} in the preview from the Variable Values panel', async () => {
		const renderOptions = ref<Partial<PreviewRenderOptions>>({});
		const canvasBlocks = ref<EditorBlock[]>([textBlock('a', 'Hi {{first_name}}, welcome')]);
		const preview = usePreview({
			canvasBlocks,
			theme: computed(() => defaultTheme),
			variableType: computed<VariableType>(() => 'personalization'),
			showMandatoryUnsubscribeFooter: computed(() => false),
			renderOptions,
		});
		preview.togglePreviewMode();

		// No value set → sample default, never the raw token.
		expect(preview.generatedHtml.value).toContain('Hi Alex, welcome');
		expect(preview.generatedHtml.value).not.toContain('{{first_name}}');

		renderOptions.value = { variableValues: { first_name: 'Marcel' } };
		await nextTick();

		expect(preview.generatedHtml.value).toContain('Hi Marcel, welcome');
		expect(preview.plainText.value).toContain('Hi Marcel, welcome');
	});

	it('defaults unknown variables to their label or humanized key', () => {
		const canvasBlocks = ref<EditorBlock[]>([
			textBlock('a', 'Your {{plan_tier}} plan, code {{coupon_code}}'),
		]);
		const preview = usePreview({
			canvasBlocks,
			theme: computed(() => defaultTheme),
			variableType: computed<VariableType>(() => 'personalization'),
			showMandatoryUnsubscribeFooter: computed(() => false),
			variables: computed(() => [{ key: 'plan_tier', label: 'Plan Tier' }]),
		});
		preview.togglePreviewMode();

		expect(preview.generatedHtml.value).toContain('Your Plan Tier plan');
		expect(preview.generatedHtml.value).toContain('code Coupon code');
	});

	it('toggles back to edit mode', () => {
		const { preview } = setup();
		preview.togglePreviewMode();
		expect(preview.previewMode.value).toBe('preview');
		preview.togglePreviewMode();
		expect(preview.previewMode.value).toBe('edit');
	});
});
