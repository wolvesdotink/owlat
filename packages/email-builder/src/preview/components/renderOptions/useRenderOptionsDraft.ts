import { inject, provide, reactive, watch, type InjectionKey } from 'vue';
import type { PreviewRenderOptions } from '../../types';

function createLocal(options: Partial<PreviewRenderOptions>) {
	return reactive({
		baseWidth: options.baseWidth ?? 600,
		breakpoint: options.breakpoint ?? 480,
		direction: options.direction ?? ('ltr' as 'ltr' | 'rtl'),
		minify: options.minify ?? false,
		inlineCss: options.inlineCss ?? true,
		validationLevel: options.validationLevel ?? ('soft' as string),
		lang: options.lang ?? 'en',
		customCss: options.customCss ?? '',
		fontUrls: [...(options.fontUrls ?? [])],
		preheaderText: options.preheaderText ?? '',
		title: options.title ?? '',
		variableValues: Object.entries(options.variableValues ?? {}).map(([key, value]) => ({
			key,
			value,
		})),
	});
}

/**
 * The render options being edited in the panel, shared by its sections: the
 * fields write to `local` and call `emitUpdate` to send the whole set out.
 */
interface RenderOptionsDraft {
	local: ReturnType<typeof createLocal>;
	emitUpdate: () => void;
	addFontUrl: () => void;
	removeFontUrl: (index: number) => void;
	addVariable: () => void;
	removeVariable: (index: number) => void;
}

const RENDER_OPTIONS_DRAFT: InjectionKey<RenderOptionsDraft> = Symbol('renderOptionsDraft');

/** Create the panel's draft from its `options` prop and share it with its sections. */
export function provideRenderOptionsDraft(
	options: () => Partial<PreviewRenderOptions>,
	update: (options: Partial<PreviewRenderOptions>) => void
): RenderOptionsDraft {
	// Local reactive state mirroring props
	const local = createLocal(options());

	// Emit on every change
	function emitUpdate() {
		const opts: Partial<PreviewRenderOptions> = {
			baseWidth: local.baseWidth,
			breakpoint: local.breakpoint,
			direction: local.direction,
			minify: local.minify,
			inlineCss: local.inlineCss,
			validationLevel: local.validationLevel as PreviewRenderOptions['validationLevel'],
			lang: local.lang,
			customCss: local.customCss || undefined,
			fontUrls:
				local.fontUrls.filter(Boolean).length > 0 ? local.fontUrls.filter(Boolean) : undefined,
			preheaderText: local.preheaderText || undefined,
			title: local.title || undefined,
			variableValues:
				local.variableValues.length > 0
					? Object.fromEntries(
							local.variableValues.filter((v) => v.key).map((v) => [v.key, v.value])
						)
					: undefined,
		};
		update(opts);
	}

	function addFontUrl() {
		local.fontUrls.push('');
	}

	function removeFontUrl(index: number) {
		local.fontUrls.splice(index, 1);
		emitUpdate();
	}

	function addVariable() {
		local.variableValues.push({ key: '', value: '' });
	}

	function removeVariable(index: number) {
		local.variableValues.splice(index, 1);
		emitUpdate();
	}

	// Sync props changes to local state
	watch(
		options,
		(newOpts) => {
			if (newOpts.baseWidth !== undefined) local.baseWidth = newOpts.baseWidth;
			if (newOpts.direction !== undefined) local.direction = newOpts.direction;
			if (newOpts.minify !== undefined) local.minify = newOpts.minify;
		},
		{ deep: true }
	);

	const draft: RenderOptionsDraft = {
		local,
		emitUpdate,
		addFontUrl,
		removeFontUrl,
		addVariable,
		removeVariable,
	};
	provide(RENDER_OPTIONS_DRAFT, draft);
	return draft;
}

/** The draft of the render options panel this section is rendered in. */
export function useRenderOptionsDraft(): RenderOptionsDraft {
	const draft = inject(RENDER_OPTIONS_DRAFT);
	if (!draft)
		throw new Error('A render options section must be rendered inside RenderOptionsPanel');
	return draft;
}
