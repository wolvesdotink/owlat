/**
 * Composable for rendering blocks via the email renderer.
 *
 * Manages debounced renderBlockFragment() calls with per-block caching.
 * Used by CanvasBlock.vue to show real renderer output in iframes.
 */
import { ref, watch, type Ref } from 'vue';
import type { EditorBlock, EmailTheme } from '../types';
import type { RenderOptions } from '@owlat/email-renderer';
import { renderBlockFragment } from '@owlat/email-renderer';

interface BlockRendererOptions {
	theme: Ref<Required<EmailTheme>>;
	/** Debounce interval in ms (default: 100) */
	debounceMs?: number;
}

/**
 * Cache of rendered HTML per block ID.
 */
const htmlCache = new Map<string, string>();

/**
 * Pending debounce timers per block ID.
 */
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Render a single block to HTML, with debouncing and caching.
 */
export function renderBlock(
	block: EditorBlock,
	theme: Required<EmailTheme>,
	debounceMs: number = 100,
): Promise<string> {
	return new Promise((resolve) => {
		// Clear any pending timer for this block
		const existing = debounceTimers.get(block.id);
		if (existing) clearTimeout(existing);

		const timer = setTimeout(() => {
			debounceTimers.delete(block.id);
			try {
				const renderOptions: RenderOptions = {
					theme,
				};
				const html = renderBlockFragment(block, renderOptions);
				htmlCache.set(block.id, html);
				resolve(html);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const fallback = `<div style="padding:16px;color:#ef4444;font-size:12px;">Render error: ${message}</div>`;
				resolve(fallback);
			}
		}, debounceMs);

		debounceTimers.set(block.id, timer);
	});
}

/**
 * Get cached HTML for a block, or empty string if not yet rendered.
 */
export function getCachedHtml(blockId: string): string {
	return htmlCache.get(blockId) ?? '';
}

/**
 * Clear cache for a block (e.g. on delete).
 */
export function clearBlockCache(blockId: string): void {
	htmlCache.delete(blockId);
	const timer = debounceTimers.get(blockId);
	if (timer) {
		clearTimeout(timer);
		debounceTimers.delete(blockId);
	}
}

/**
 * Clear all caches.
 */
export function clearAllBlockCaches(): void {
	htmlCache.clear();
	for (const timer of debounceTimers.values()) {
		clearTimeout(timer);
	}
	debounceTimers.clear();
}

/**
 * Composable that provides reactive block rendering for a single block.
 */
export function useBlockRenderer(
	block: Ref<EditorBlock>,
	options: BlockRendererOptions,
) {
	const html = ref(getCachedHtml(block.value.id));
	const isRendering = ref(false);

	async function render() {
		isRendering.value = true;
		html.value = await renderBlock(
			block.value,
			options.theme.value,
			options.debounceMs ?? 100,
		);
		isRendering.value = false;
	}

	// Re-render whenever block content changes (deep watch, no JSON.stringify)
	watch(
		() => block.value.content,
		() => render(),
		{ immediate: true, deep: true },
	);

	// Re-render when theme changes
	watch(
		() => options.theme.value,
		() => render(),
		{ deep: true },
	);

	return {
		html,
		isRendering,
		render,
	};
}
