import { computed, ref, watch, type Ref, type ComputedRef } from 'vue';
import type {
	EditorBlock,
	PreviewMode,
	PreviewDevice,
	EmailTheme,
	Variable,
	VariableType,
} from '../types';
import { fillPreviewVariables } from '../utils/variables';
import { renderEmailHtml } from '@owlat/email-renderer';
import { renderPlainText } from '@owlat/email-renderer';
import { renderAmpEmail } from '@owlat/email-renderer';
import { analyzeEmail, getEmailHealthScore, suggestOptimizations } from '@owlat/email-renderer';
import { validateBlocks } from '@owlat/email-renderer';
import { diffEmails } from '@owlat/email-renderer';
import type {
	RenderOptions,
	TargetClient,
	ValidationLevel,
	EmailHealthScore,
} from '@owlat/email-renderer';
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
	/** Available variables (for default preview values via their labels) */
	variables?: Ref<Variable[]> | ComputedRef<Variable[]>;
}

export interface UsePreviewReturn {
	previewMode: Ref<PreviewMode>;
	previewDevice: Ref<PreviewDevice>;
	previewDarkMode: Ref<boolean>;
	generatedHtml: Ref<string>;
	isGeneratingHtml: Ref<boolean>;
	plainText: Ref<string>;
	/** The generated plain text WITHOUT preview variable substitution. */
	plainTextSource: Ref<string>;
	/**
	 * AMP HTML for the current content. Rendered only while `ampRequested` is
	 * true (the AMP view or the export menu is open); otherwise it is the last
	 * AMP rendered for unchanged content, or '' once the content has moved on,
	 * so nothing can read a stale AMP body.
	 */
	ampHtml: Ref<string>;
	/** Set while a view or export needs `ampHtml`; flipping it on renders AMP on demand. */
	ampRequested: Ref<boolean>;
	renderWarnings: Ref<string[]>;
	emailAnalysis: Ref<EmailAnalysis | null>;
	healthScore: Ref<EmailHealthScore | null>;
	validationIssues: Ref<ValidationIssue[]>;
	/** Computed on first read from `generatedHtml`; nothing is spent while no one reads it. */
	optimizations: Readonly<Ref<OptimizationSuggestion[]>>;
	emailDiff: Ref<EmailDiff | null>;

	generateEmailHtml: (darkMode?: boolean) => string;
	generatePlainText: (options?: { fillVariables?: boolean }) => string;
	generateAmpHtml: () => string;
	runAnalysis: () => void;
	/** Re-render every artifact after a Block, theme or render-option change. */
	regenerate: () => void;
	/**
	 * Re-render only the HTML and its analysis (e.g. after a dark-mode change).
	 * Plain text, AMP and Block validation do not depend on dark mode and are kept.
	 */
	regenerateHtml: () => void;
	togglePreviewMode: () => void;
	toggleDarkModePreview: () => void;
}

/**
 * Composable for managing preview state
 */
export function usePreview(options: UsePreviewOptions): UsePreviewReturn {
	const {
		canvasBlocks,
		theme,
		variableType,
		showMandatoryUnsubscribeFooter,
		renderOptions,
		variables,
	} = options;

	const previewMode = ref<PreviewMode>('edit');
	const previewDevice = ref<PreviewDevice>('desktop');
	const previewDarkMode = ref(false);
	const generatedHtml = ref('');
	const isGeneratingHtml = ref(false);
	const plainText = ref('');
	const plainTextSource = ref('');
	const ampHtml = ref('');
	const ampRequested = ref(false);
	const renderWarnings = ref<string[]>([]);
	const emailAnalysis = ref<EmailAnalysis | null>(null);
	const healthScore = ref<EmailHealthScore | null>(null);
	const validationIssues = ref<ValidationIssue[]>([]);
	const emailDiff = ref<EmailDiff | null>(null);
	const previousHtml = ref('');
	// Bumped by every content regenerate; AMP is cached against it.
	let contentVersion = 0;
	let ampVersion = -1;
	// Block validation for the current content, shared with health scoring.
	// `undefined` when validation threw, so health scoring runs its own pass.
	let contentValidationIssues: ValidationIssue[] | undefined;

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

	// Preview-time variable substitution. The renderer intentionally leaves
	// {{var}} tokens in its output (send-time personalization is a separate
	// per-recipient backend pass), so the preview fills them here: user-set
	// Variable Values first, then inline fallbacks, then generated defaults.
	const fillVariables = (content: string, escape: boolean): string => {
		const labels: Record<string, string> = {};
		for (const v of variables?.value ?? []) labels[v.key] = v.label;
		return fillPreviewVariables(content, {
			values: renderOptions?.value?.variableValues ?? {},
			labels,
			escape,
		});
	};

	// Generate HTML from blocks (synchronous)
	const generateEmailHtml = (darkMode = false): string => {
		const opts = buildRenderOptions(darkMode);
		const warnings: string[] = [];
		opts.onWarning = (msg: string) => warnings.push(msg);

		const html = renderEmailHtml(canvasBlocks.value, opts);
		renderWarnings.value = warnings;
		return appendMandatoryUnsubscribeFooter(fillVariables(html, true));
	};

	// Generate plain text from blocks. Variables are filled for the preview, but
	// a caller seeding a manual override wants the raw `{{token}}` body — the
	// stored override is personalized per recipient at send time, so freezing a
	// preview value into it would ship the same name to everyone.
	const renderRawPlainText = (): string =>
		renderPlainText(canvasBlocks.value, buildRenderOptions());

	const generatePlainText = (options?: { fillVariables?: boolean }): string => {
		const raw = renderRawPlainText();
		return options?.fillVariables === false ? raw : fillVariables(raw, false);
	};

	// Generate AMP HTML from blocks
	const generateAmpHtml = (): string => {
		const opts = buildRenderOptions();
		return fillVariables(renderAmpEmail(canvasBlocks.value, opts), true);
	};

	// Validate the Blocks once per content change. Health scoring validates
	// with level 'soft'; the level only changes `valid`, never the issue list, so
	// the same issues feed both the Validation tab and the accessibility score.
	const validateContent = () => {
		try {
			contentValidationIssues = validateBlocks(canvasBlocks.value, {
				accessibilityAudit: true,
			}).issues;
		} catch {
			contentValidationIssues = undefined;
		}
		validationIssues.value = contentValidationIssues ?? [];
	};

	// Analyze the current HTML: one analyzeEmail pass, shared with health scoring.
	const analyzeHtml = () => {
		const html = generatedHtml.value;
		if (!html) {
			emailAnalysis.value = null;
			healthScore.value = null;
			return;
		}

		let analysis: EmailAnalysis | null;
		try {
			analysis = analyzeEmail(html);
		} catch {
			analysis = null;
		}
		emailAnalysis.value = analysis;

		try {
			healthScore.value = getEmailHealthScore(canvasBlocks.value, html, undefined, {
				analysis: analysis ?? undefined,
				validationIssues: contentValidationIssues,
			});
		} catch {
			healthScore.value = null;
		}
	};

	// Run analysis on current HTML
	const runAnalysis = () => {
		if (!generatedHtml.value) {
			emailAnalysis.value = null;
			healthScore.value = null;
			validationIssues.value = [];
			return;
		}
		validateContent();
		analyzeHtml();
	};

	// Nothing in the editor reads the suggestions, so they are derived on demand.
	const optimizations = computed<OptimizationSuggestion[]>(() => {
		if (!generatedHtml.value) return [];
		try {
			return suggestOptimizations(generatedHtml.value);
		} catch {
			return [];
		}
	});

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

	// Render AMP only while a view or export asks for it, once per content
	// version. Unrequested AMP for outdated content is dropped rather than kept.
	const syncAmp = () => {
		if (ampVersion === contentVersion) return;
		if (ampRequested.value) {
			ampHtml.value = generateAmpHtml();
			ampVersion = contentVersion;
		} else {
			ampHtml.value = '';
		}
	};
	watch(ampRequested, syncAmp, { flush: 'sync' });

	// HTML, its analysis and the diff against the previous render. Shared by the
	// dark-mode path, which changes nothing else.
	const renderHtml = () => {
		previousHtml.value = generatedHtml.value;
		generatedHtml.value = generateEmailHtml(previewDarkMode.value);
		analyzeHtml();
		computeDiff();
	};

	// Regenerate the preview artifacts from the current canvas + render options.
	// Shared by the toggle, the render-options watch, and host-driven re-renders
	// so each content change produces a complete, consistent preview. Plain text
	// is rendered once and the substituted copy derived from it; AMP follows
	// `ampRequested`.
	const regenerate = () => {
		contentVersion++;
		const rawPlainText = renderRawPlainText();
		plainTextSource.value = rawPlainText;
		plainText.value = fillVariables(rawPlainText, false);
		validateContent();
		renderHtml();
		syncAmp();
	};

	const regenerateHtml = () => {
		renderHtml();
	};

	// Toggle preview mode
	const togglePreviewMode = () => {
		if (previewMode.value === 'edit') {
			previewMode.value = 'preview';
			regenerate();
		} else {
			previewMode.value = 'edit';
			ampRequested.value = false;
		}
	};

	// Toggle dark mode preview
	const toggleDarkModePreview = () => {
		previewDarkMode.value = !previewDarkMode.value;
		if (previewMode.value !== 'edit') regenerateHtml();
	};

	// Re-render when render options change while in preview mode
	if (renderOptions) {
		watch(
			renderOptions,
			() => {
				if (previewMode.value !== 'edit') regenerate();
			},
			{ deep: true }
		);
	}

	return {
		previewMode,
		previewDevice,
		previewDarkMode,
		generatedHtml,
		isGeneratingHtml,
		plainText,
		plainTextSource,
		ampHtml,
		ampRequested,
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
		regenerateHtml,
		togglePreviewMode,
		toggleDarkModePreview,
	};
}
