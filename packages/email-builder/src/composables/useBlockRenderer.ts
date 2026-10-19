/**
 * Composable for rendering blocks via the email renderer.
 *
 * Manages debounced renderBlockFragment() calls for the canvas previews that
 * show real renderer output in iframes (IframePreview.vue).
 *
 * Lifetimes:
 * - Cache: one per editor (provideBlockRenderCache in EmailBuilder.vue), keyed
 *   by Block ID and checked against the Block and theme the HTML came from, so
 *   a duplicated template or a theme change never seeds stale HTML. The editor
 *   releases it when its scope is disposed. A renderer with no editor above it
 *   has no cache.
 * - Jobs: one debounce timer per useBlockRenderer instance, so two previews of
 *   the same Block ID never cancel each other. Disposing the instance clears the
 *   timer and settles its pending calls without touching its state.
 *
 * Every call settles. A call superseded by a newer one on the same job resolves
 * with the newer call's result.
 */
import {
	getCurrentScope,
	hasInjectionContext,
	inject,
	onScopeDispose,
	provide,
	ref,
	watch,
	type InjectionKey,
	type Ref,
} from 'vue';
import type { EditorBlock, EmailTheme } from '../types';
import { renderBlockFragment } from '@owlat/email-renderer';

interface BlockRendererOptions {
	theme: Ref<Required<EmailTheme>>;
	/** Debounce interval in ms (default: 100) */
	debounceMs?: number;
}

type BlockRenderOutcome = { status: 'rendered'; html: string } | { status: 'cancelled' };

/** Called when a timer fires; `ok` is false when the HTML is the error fallback. */
type RenderedListener = (
	block: EditorBlock,
	theme: Required<EmailTheme>,
	html: string,
	ok: boolean
) => void;

function renderFragmentHtml(
	block: EditorBlock,
	theme: Required<EmailTheme>
): { html: string; ok: boolean } {
	try {
		return { html: renderBlockFragment(block, { theme }), ok: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const fallback = `<div style="padding:16px;color:#ef4444;font-size:12px;">Render error: ${message}</div>`;
		return { html: fallback, ok: false };
	}
}

/**
 * One debounced render slot. Scheduling again replaces the pending timer and
 * the earlier callers get the newer result; cancel() settles them as cancelled.
 */
function createFragmentJob(onRendered: RenderedListener) {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let waiting: Array<(outcome: BlockRenderOutcome) => void> = [];

	function settle(outcome: BlockRenderOutcome) {
		const callers = waiting;
		waiting = [];
		for (const resolve of callers) resolve(outcome);
	}

	return {
		schedule(
			block: EditorBlock,
			theme: Required<EmailTheme>,
			debounceMs: number
		): Promise<BlockRenderOutcome> {
			if (timer !== null) clearTimeout(timer);
			const outcome = new Promise<BlockRenderOutcome>((resolve) => waiting.push(resolve));
			timer = setTimeout(() => {
				timer = null;
				const { html, ok } = renderFragmentHtml(block, theme);
				onRendered(block, theme, html, ok);
				settle({ status: 'rendered', html });
			}, debounceMs);
			return outcome;
		},
		cancel() {
			if (timer !== null) clearTimeout(timer);
			timer = null;
			settle({ status: 'cancelled' });
		},
	};
}

// ---------------------------------------------------------------------------
// Legacy helpers: one module-wide job per Block ID and an ID-keyed cache. The
// editor canvas does not use them; they keep their original contract for any
// direct caller.
// ---------------------------------------------------------------------------

const htmlCache = new Map<string, string>();
const legacyJobs = new Map<string, ReturnType<typeof createFragmentJob>>();

/**
 * Render a single block to HTML, with debouncing and caching. A call made
 * while an earlier one for the same Block ID is still waiting replaces it, and
 * both resolve with the newer render.
 */
export function renderBlock(
	block: EditorBlock,
	theme: Required<EmailTheme>,
	debounceMs: number = 100
): Promise<string> {
	let job = legacyJobs.get(block.id);
	if (!job) {
		job = createFragmentJob((rendered, _theme, html, ok) => {
			legacyJobs.delete(rendered.id);
			if (ok) htmlCache.set(rendered.id, html);
		});
		legacyJobs.set(block.id, job);
	}
	// Legacy jobs are never cancelled.
	return job
		.schedule(block, theme, debounceMs)
		.then((outcome) => (outcome.status === 'rendered' ? outcome.html : ''));
}

/**
 * Get cached HTML for a block, or empty string if not yet rendered.
 */
export function getCachedHtml(blockId: string): string {
	return htmlCache.get(blockId) ?? '';
}

// ---------------------------------------------------------------------------
// Editor-scoped cache
// ---------------------------------------------------------------------------

interface BlockRenderCache {
	/** HTML last rendered from exactly this Block and theme, or ''. */
	get(block: EditorBlock, theme: Required<EmailTheme>): string;
	set(block: EditorBlock, theme: Required<EmailTheme>, html: string): void;
	/** Drop every entry and ignore later writes. */
	release(): void;
}

const BLOCK_RENDER_CACHE_KEY: InjectionKey<BlockRenderCache> = Symbol('blockRenderCache');

/** The rendered inputs; null when they cannot be serialized (never cached then). */
function renderInputs(block: EditorBlock, theme: Required<EmailTheme>): string | null {
	try {
		return JSON.stringify([block, theme]);
	} catch {
		return null;
	}
}

function createBlockRenderCache(): BlockRenderCache {
	const entries = new Map<string, { inputs: string; html: string }>();
	let released = false;
	return {
		get(block, theme) {
			const entry = entries.get(block.id);
			if (!entry) return '';
			return entry.inputs === renderInputs(block, theme) ? entry.html : '';
		},
		set(block, theme, html) {
			if (released) return;
			const inputs = renderInputs(block, theme);
			if (inputs === null) entries.delete(block.id);
			else entries.set(block.id, { inputs, html });
		},
		release() {
			released = true;
			entries.clear();
		},
	};
}

/**
 * Give the editor's canvas previews one fragment cache, released with the
 * calling component.
 */
export function provideBlockRenderCache(): BlockRenderCache {
	const cache = createBlockRenderCache();
	provide(BLOCK_RENDER_CACHE_KEY, cache);
	onScopeDispose(() => cache.release());
	return cache;
}

/**
 * Composable that provides reactive block rendering for a single block.
 */
export function useBlockRenderer(block: Ref<EditorBlock>, options: BlockRendererOptions) {
	const cache = hasInjectionContext() ? inject(BLOCK_RENDER_CACHE_KEY, null) : null;
	const job = createFragmentJob((rendered, theme, renderedHtml, ok) => {
		if (ok) cache?.set(rendered, theme, renderedHtml);
	});
	const html = ref(cache?.get(block.value, options.theme.value) ?? '');
	const isRendering = ref(false);
	let latestRequest = 0;
	let disposed = false;

	async function render() {
		if (disposed) return;
		const request = ++latestRequest;
		isRendering.value = true;
		const outcome = await job.schedule(block.value, options.theme.value, options.debounceMs ?? 100);
		// Only the newest call applies a result, and never after disposal.
		if (disposed || request !== latestRequest || outcome.status !== 'rendered') return;
		html.value = outcome.html;
		isRendering.value = false;
	}

	// Re-render whenever block content changes (deep watch, no JSON.stringify)
	watch(
		() => block.value.content,
		() => render(),
		{ immediate: true, deep: true }
	);

	// Re-render when theme changes
	watch(
		() => options.theme.value,
		() => render(),
		{ deep: true }
	);

	if (getCurrentScope()) {
		onScopeDispose(() => {
			disposed = true;
			job.cancel();
		});
	}

	return {
		html,
		isRendering,
		render,
	};
}
