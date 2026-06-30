import { ref, watch, type Ref, type ComputedRef } from 'vue';
import type { EditorBlock, PreviewMode, PreviewDevice, EmailTheme, VariableType } from '../types';
import { renderEmailHtml } from '@owlat/email-renderer';
import { renderPlainText } from '@owlat/email-renderer';
import { renderAmpEmail } from '@owlat/email-renderer';
import { analyzeEmail, getEmailHealthScore, suggestOptimizations } from '@owlat/email-renderer';
import { validateBlocks } from '@owlat/email-renderer';
import { diffEmails } from '@owlat/email-renderer';
import type { RenderOptions, TargetClient, ValidationLevel, EmailHealthScore } from '@owlat/email-renderer';
import type { EmailAnalysis, OptimizationSuggestion } from '@owlat/email-renderer';
import type { ValidationIssue } from '@owlat/email-renderer';
import type { EmailDiff } from '@owlat/email-renderer';

export interface PreviewRenderOptions {
	baseWidth?: number;
	breakpoint?: number;
	fontUrls?: string[];
	customCss?: string;
	inlineCss?: boolean;
	variableValues?: Record<string, string>;
	linkTransform?: (url: string, context: { blockType: string; blockId: string }) => string;
	targetClient?: TargetClient;
	minify?: boolean;
	validationLevel?: ValidationLevel;
	title?: string;
	preheaderText?: string;
	lang?: string;
	direction?: 'ltr' | 'rtl';
}

export interface UsePreviewOptions {
	canvasBlocks: Ref<EditorBlock[]>;
	theme: ComputedRef<Required<EmailTheme>>;
	variableType: ComputedRef<VariableType>;
	showMandatoryUnsubscribeFooter: ComputedRef<boolean>;
	renderOptions?: Ref<Partial<PreviewRenderOptions>>;
}

export interface UsePreviewReturn {
	previewMode: Ref<PreviewMode>;
	previewDevice: Ref<PreviewDevice>;
	previewDarkMode: Ref<boolean>;
	generatedHtml: Ref<string>;
	isGeneratingHtml: Ref<boolean>;
	plainText: Ref<string>;
	ampHtml: Ref<string>;
	renderWarnings: Ref<string[]>;
	emailAnalysis: Ref<EmailAnalysis | null>;
	healthScore: Ref<EmailHealthScore | null>;
	validationIssues: Ref<ValidationIssue[]>;
	optimizations: Ref<OptimizationSuggestion[]>;
	emailDiff: Ref<EmailDiff | null>;

	generateEmailHtml: (darkMode?: boolean) => string;
	generatePlainText: () => string;
	generateAmpHtml: () => string;
	runAnalysis: () => void;
	regenerate: () => void;
	togglePreviewMode: () => void;
	toggleDarkModePreview: () => void;
}

/**
 * Composable for managing preview state
 */
export function usePreview(options: UsePreviewOptions): UsePreviewReturn {
	const { canvasBlocks, theme, variableType, showMandatoryUnsubscribeFooter, renderOptions } = options;

	const previewMode = ref<PreviewMode>('edit');
	const previewDevice = ref<PreviewDevice>('desktop');
	const previewDarkMode = ref(false);
	const generatedHtml = ref('');
	const isGeneratingHtml = ref(false);
	const plainText = ref('');
	const ampHtml = ref('');
	const renderWarnings = ref<string[]>([]);
	const emailAnalysis = ref<EmailAnalysis | null>(null);
	const healthScore = ref<EmailHealthScore | null>(null);
	const validationIssues = ref<ValidationIssue[]>([]);
	const optimizations = ref<OptimizationSuggestion[]>([]);
	const emailDiff = ref<EmailDiff | null>(null);
	const previousHtml = ref('');

	const appendMandatoryUnsubscribeFooter = (html: string): string => {
		if (!showMandatoryUnsubscribeFooter.value) return html;
		if (html.includes('data-owlat-required-unsubscribe-footer="true"')) return html;

		const footerHtml = `
<div data-owlat-required-unsubscribe-footer="true" style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;text-align:center;font-size:12px;line-height:1.6;color:#6b7280;">
  <p style="margin:0;">You are receiving this email because you subscribed to our newsletter.</p>
  <p style="margin:6px 0 0;"><a href="#" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a></p>
</div>`;

		if (/<\/body>/i.test(html)) {
			return html.replace(/<\/body>/i, `${footerHtml}</body>`);
		}

		return `${html}${footerHtml}`;
	};

	/** Build merged render options for the renderer */
	const buildRenderOptions = (darkMode = false): RenderOptions => {
		const opts = renderOptions?.value ?? {};
		const warnings: string[] = [];

		const merged: RenderOptions = {
			theme: theme.value,
			darkMode,
			variableType: variableType.value,
			onWarning: (msg: string) => warnings.push(msg),
		};

		if (opts.baseWidth !== undefined) merged.baseWidth = opts.baseWidth;
		if (opts.breakpoint !== undefined) merged.breakpoint = opts.breakpoint;
		if (opts.fontUrls !== undefined) merged.fontUrls = opts.fontUrls;
		if (opts.customCss !== undefined) merged.customCss = opts.customCss;
		if (opts.inlineCss !== undefined) merged.inlineCss = opts.inlineCss;
		if (opts.variableValues !== undefined) merged.variableValues = opts.variableValues;
		if (opts.linkTransform !== undefined) merged.linkTransform = opts.linkTransform;
		if (opts.targetClient !== undefined) merged.targetClient = opts.targetClient;
		if (opts.minify !== undefined) merged.minify = opts.minify;
		if (opts.validationLevel !== undefined) merged.validationLevel = opts.validationLevel;
		if (opts.title !== undefined) merged.title = opts.title;
		if (opts.preheaderText !== undefined) merged.preheaderText = opts.preheaderText;
		if (opts.lang !== undefined) merged.lang = opts.lang;
		if (opts.direction !== undefined) merged.direction = opts.direction;

		return merged;
	};

	// Generate HTML from blocks (synchronous)
	const generateEmailHtml = (darkMode = false): string => {
		const opts = buildRenderOptions(darkMode);
		const warnings: string[] = [];
		opts.onWarning = (msg: string) => warnings.push(msg);

		const html = renderEmailHtml(canvasBlocks.value, opts);
		renderWarnings.value = warnings;
		return appendMandatoryUnsubscribeFooter(html);
	};

	// Generate plain text from blocks
	const generatePlainText = (): string => {
		const opts = buildRenderOptions();
		return renderPlainText(canvasBlocks.value, opts);
	};

	// Generate AMP HTML from blocks
	const generateAmpHtml = (): string => {
		const opts = buildRenderOptions();
		return renderAmpEmail(canvasBlocks.value, opts);
	};

	// Run analysis on current HTML
	const runAnalysis = () => {
		const html = generatedHtml.value;
		if (!html) {
			emailAnalysis.value = null;
			healthScore.value = null;
			validationIssues.value = [];
			optimizations.value = [];
			return;
		}

		try {
			emailAnalysis.value = analyzeEmail(html);
		} catch {
			emailAnalysis.value = null;
		}

		try {
			healthScore.value = getEmailHealthScore(canvasBlocks.value, html);
		} catch {
			healthScore.value = null;
		}

		try {
			const result = validateBlocks(canvasBlocks.value, { accessibilityAudit: true });
			validationIssues.value = result.issues;
		} catch {
			validationIssues.value = [];
		}

		try {
			optimizations.value = suggestOptimizations(html);
		} catch {
			optimizations.value = [];
		}
	};

	// Compute diff when HTML changes
	const computeDiff = () => {
		if (!previousHtml.value || !generatedHtml.value) {
			emailDiff.value = null;
			return;
		}
		try {
			emailDiff.value = diffEmails(previousHtml.value, generatedHtml.value);
		} catch {
			emailDiff.value = null;
		}
	};

	// Regenerate every derived preview artifact (html, plain text, AMP, analysis,
	// diff) from the current canvas + render options. Shared by the toggle, the
	// dark-mode toggle, the render-options watch, and host-driven re-renders so
	// each control change produces a complete, consistent preview.
	const regenerate = () => {
		previousHtml.value = generatedHtml.value;
		generatedHtml.value = generateEmailHtml(previewDarkMode.value);
		plainText.value = generatePlainText();
		ampHtml.value = generateAmpHtml();
		runAnalysis();
		computeDiff();
	};

	// Toggle preview mode
	const togglePreviewMode = () => {
		if (previewMode.value === 'edit') {
			previewMode.value = 'preview';
			regenerate();
		} else {
			previewMode.value = 'edit';
		}
	};

	// Toggle dark mode preview
	const toggleDarkModePreview = () => {
		previewDarkMode.value = !previewDarkMode.value;
		if (previewMode.value !== 'edit') regenerate();
	};

	// Re-render when render options change while in preview mode
	if (renderOptions) {
		watch(renderOptions, () => {
			if (previewMode.value !== 'edit') regenerate();
		}, { deep: true });
	}

	return {
		previewMode,
		previewDevice,
		previewDarkMode,
		generatedHtml,
		isGeneratingHtml,
		plainText,
		ampHtml,
		renderWarnings,
		emailAnalysis,
		healthScore,
		validationIssues,
		optimizations,
		emailDiff,
		generateEmailHtml,
		generatePlainText,
		generateAmpHtml,
		runAnalysis,
		regenerate,
		togglePreviewMode,
		toggleDarkModePreview,
	};
}
