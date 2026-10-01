import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, computed, toRaw } from 'vue';
import {
	renderEmailHtml,
	renderPlainText,
	renderAmpEmail,
	analyzeEmail,
	getEmailHealthScore,
	suggestOptimizations,
	validateBlocks,
	diffEmails,
} from '@owlat/email-renderer';
import { usePreview, type PreviewRenderOptions } from '../usePreview';
import { defaultTheme } from '../../defaults';
import { createBlock } from '../../utils/blocks';
import type { EditorBlock, VariableType } from '../../types';

/**
 * Cost bounds for the preview generations (issue #923). Every renderer entry
 * point `usePreview` calls is wrapped in a pass-through spy, so these tests pin
 * how much work one generation does, and that the shared/lazy results stay equal
 * to what the eager path used to produce.
 */
vi.mock('@owlat/email-renderer', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	const spied = [
		'renderEmailHtml',
		'renderPlainText',
		'renderAmpEmail',
		'analyzeEmail',
		'getEmailHealthScore',
		'suggestOptimizations',
		'validateBlocks',
		'diffEmails',
	];
	return {
		...actual,
		...Object.fromEntries(spied.map((k) => [k, vi.fn(actual[k] as (...a: unknown[]) => unknown)])),
	};
});

const renderer = {
	renderEmailHtml,
	renderPlainText,
	renderAmpEmail,
	analyzeEmail,
	getEmailHealthScore,
	suggestOptimizations,
	validateBlocks,
	diffEmails,
};
const SPIED = Object.keys(renderer) as (keyof typeof renderer)[];

const calls = () =>
	Object.fromEntries(
		SPIED.map((k) => [k, vi.mocked(renderer[k] as (...a: unknown[]) => unknown).mock.calls.length])
	) as Record<(typeof SPIED)[number], number>;

function textBlock(id: string, html: string): EditorBlock {
	return {
		id,
		type: 'text',
		content: { html, blockType: 'paragraph', fontSize: 16, textColor: '#111111' },
	};
}

function setup(blocks: EditorBlock[] = [textBlock('a', 'Hi {{firstName}}, welcome')]) {
	const canvasBlocks = ref<EditorBlock[]>(blocks);
	const renderOptions = ref<Partial<PreviewRenderOptions>>({
		variableValues: { firstName: 'Jane' },
	});
	const preview = usePreview({
		canvasBlocks,
		theme: computed(() => defaultTheme),
		variableType: computed<VariableType>(() => 'personalization'),
		showMandatoryUnsubscribeFooter: computed(() => true),
		renderOptions,
	});
	return { canvasBlocks, renderOptions, preview };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('usePreview — work per generation', () => {
	it('entering preview renders plain text once, validates once, analyzes once and skips AMP', () => {
		const { preview } = setup();
		preview.togglePreviewMode();

		expect(calls()).toMatchObject({
			renderEmailHtml: 1,
			renderPlainText: 1,
			renderAmpEmail: 0,
			analyzeEmail: 1,
			getEmailHealthScore: 1,
			validateBlocks: 1,
			suggestOptimizations: 0,
		});
		// One plaintext render still feeds both the filled preview and the raw source.
		expect(preview.plainText.value).toBe('Hi Jane, welcome');
		expect(preview.plainTextSource.value).toBe('Hi {{firstName}}, welcome');
		expect(preview.ampHtml.value).toBe('');
	});

	it('hands its own analysis and validation to health scoring', () => {
		const { preview } = setup();
		preview.togglePreviewMode();

		const [, , , inputs] = vi.mocked(getEmailHealthScore).mock.calls[0]!;
		expect(inputs?.analysis).toBe(toRaw(preview.emailAnalysis.value));
		expect(inputs?.validationIssues).toBe(toRaw(preview.validationIssues.value));
	});

	it('a dark-mode toggle re-renders only the HTML and its analysis', () => {
		const { preview } = setup();
		preview.togglePreviewMode();
		const lightHtml = preview.generatedHtml.value;
		const plain = preview.plainText.value;
		vi.clearAllMocks();

		preview.toggleDarkModePreview();

		expect(calls()).toMatchObject({
			renderEmailHtml: 1,
			renderPlainText: 0,
			renderAmpEmail: 0,
			validateBlocks: 0,
			analyzeEmail: 1,
			getEmailHealthScore: 1,
			diffEmails: 1,
		});
		expect(vi.mocked(renderEmailHtml).mock.calls[0]![1]?.darkMode).toBe(true);
		expect(preview.generatedHtml.value).not.toBe(lightHtml);
		expect(preview.plainText.value).toBe(plain);
		// The diff still compares against the render the author was looking at.
		expect(vi.mocked(diffEmails).mock.calls[0]![0]).toBe(lightHtml);
	});

	it('shared results match what the standalone renderer calls produce', () => {
		const blocks = [
			createBlock('text'),
			createBlock('image'),
			createBlock('button'),
			createBlock('columns'),
			createBlock('container'),
		];
		const { preview, canvasBlocks } = setup(blocks);
		preview.togglePreviewMode();
		preview.toggleDarkModePreview();

		const html = preview.generatedHtml.value;
		expect(preview.emailAnalysis.value).toEqual(analyzeEmail(html));
		expect(preview.healthScore.value).toEqual(getEmailHealthScore(canvasBlocks.value, html));
		expect(preview.validationIssues.value).toEqual(
			validateBlocks(canvasBlocks.value, { accessibilityAudit: true }).issues
		);
		// Optimizations are derived on first read, and equal the eager value.
		vi.clearAllMocks();
		expect(preview.optimizations.value).toEqual(suggestOptimizations(html));
	});

	it('computes optimizations only when read', () => {
		const { preview } = setup();
		preview.togglePreviewMode();
		preview.regenerate();
		expect(calls().suggestOptimizations).toBe(0);
		void preview.optimizations.value;
		void preview.optimizations.value;
		expect(calls().suggestOptimizations).toBe(1);
	});
});

describe('usePreview — AMP on request', () => {
	it('renders AMP when requested and reuses it while the content is unchanged', () => {
		const { preview } = setup();
		preview.togglePreviewMode();

		preview.ampRequested.value = true;
		expect(calls().renderAmpEmail).toBe(1);
		expect(preview.ampHtml.value).toContain('Hi Jane, welcome');

		// Switching views away and back, or toggling dark mode, reuses it.
		preview.ampRequested.value = false;
		preview.ampRequested.value = true;
		preview.toggleDarkModePreview();
		expect(calls().renderAmpEmail).toBe(1);
	});

	it('re-renders requested AMP with the content so an open AMP view stays current', () => {
		const { canvasBlocks, preview } = setup();
		preview.togglePreviewMode();
		preview.ampRequested.value = true;

		canvasBlocks.value = [textBlock('a', 'Edited body')];
		preview.regenerate();

		expect(calls().renderAmpEmail).toBe(2);
		expect(preview.ampHtml.value).toContain('Edited body');
	});

	it('never exposes AMP for outdated content once it is no longer requested', () => {
		const { canvasBlocks, renderOptions, preview } = setup();
		preview.togglePreviewMode();
		preview.ampRequested.value = true;
		preview.ampRequested.value = false;

		canvasBlocks.value = [textBlock('a', 'Edited body')];
		renderOptions.value = { title: 'New title' };
		preview.regenerate();
		expect(preview.ampHtml.value).toBe('');
		expect(calls().renderAmpEmail).toBe(1);

		// An export opening the menu gets AMP for the current content.
		preview.ampRequested.value = true;
		expect(preview.ampHtml.value).toContain('Edited body');
		expect(preview.ampHtml.value).toContain('<title>New title</title>');
	});

	it('drops the AMP request when leaving preview', () => {
		const { preview } = setup();
		preview.togglePreviewMode();
		preview.ampRequested.value = true;
		preview.togglePreviewMode();
		expect(preview.ampRequested.value).toBe(false);
	});
});
