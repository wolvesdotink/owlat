// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, effectScope, h, ref, type App, type Ref } from 'vue';
import type { EditorBlock, EmailTheme } from '../../types';

const { renderBlockFragment } = vi.hoisted(() => ({
	renderBlockFragment: vi.fn(
		(block: EditorBlock, options: { theme?: { primaryColor?: string } }) =>
			`<p>${block.id}|${String((block.content as { text?: string }).text)}|${options.theme?.primaryColor}</p>`
	),
}));
vi.mock('@owlat/email-renderer', () => ({ renderBlockFragment }));

import {
	getCachedHtml,
	provideBlockRenderCache,
	renderBlock,
	useBlockRenderer,
} from '../useBlockRenderer';

type Theme = Required<EmailTheme>;

function makeBlock(id: string, text: string): EditorBlock {
	return { id, type: 'rawHtml', content: { text } } as unknown as EditorBlock;
}

function makeTheme(primaryColor: string): Theme {
	return { primaryColor } as unknown as Theme;
}

/** Track every promise so a test can prove all of them settled. */
function settledFlags<T>(promises: Promise<T>[]) {
	const flags = promises.map(() => false);
	for (const [i, p] of promises.entries()) {
		const mark = () => {
			flags[i] = true;
		};
		p.then(mark, mark);
	}
	return flags;
}

beforeEach(() => {
	vi.useFakeTimers();
	renderBlockFragment.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('renderBlock (legacy helper)', () => {
	it('settles every one of 1,000 rapid calls with the latest render and leaves no timer', async () => {
		const theme = makeTheme('#111');
		const calls = Array.from({ length: 1000 }, (_, i) =>
			renderBlock(makeBlock('legacy-a', `v${i}`), theme, 100)
		);
		const settled = settledFlags(calls);

		await vi.advanceTimersByTimeAsync(100);
		const results = await Promise.all(calls);

		expect(settled.every(Boolean)).toBe(true);
		expect(new Set(results)).toEqual(new Set(['<p>legacy-a|v999|#111</p>']));
		expect(renderBlockFragment).toHaveBeenCalledTimes(1);
		expect(getCachedHtml('legacy-a')).toBe('<p>legacy-a|v999|#111</p>');
		expect(vi.getTimerCount()).toBe(0);
	});

	it('keeps different Block IDs independent', async () => {
		const theme = makeTheme('#111');
		const a = renderBlock(makeBlock('legacy-b', 'one'), theme, 100);
		const b = renderBlock(makeBlock('legacy-c', 'two'), theme, 100);
		await vi.advanceTimersByTimeAsync(100);
		expect(await a).toBe('<p>legacy-b|one|#111</p>');
		expect(await b).toBe('<p>legacy-c|two|#111</p>');
	});

	it('resolves a render error with the fallback HTML and does not cache it', async () => {
		renderBlockFragment.mockImplementationOnce(() => {
			throw new Error('boom');
		});
		const result = renderBlock(makeBlock('legacy-err', 'x'), makeTheme('#111'), 100);
		await vi.advanceTimersByTimeAsync(100);
		expect(await result).toContain('Render error: boom');
		expect(getCachedHtml('legacy-err')).toBe('');
	});

	it('starts a fresh job once the previous one has fired', async () => {
		const theme = makeTheme('#111');
		const first = renderBlock(makeBlock('legacy-d', 'one'), theme, 100);
		await vi.advanceTimersByTimeAsync(100);
		const second = renderBlock(makeBlock('legacy-d', 'two'), theme, 100);
		await vi.advanceTimersByTimeAsync(100);
		expect(await first).toBe('<p>legacy-d|one|#111</p>');
		expect(await second).toBe('<p>legacy-d|two|#111</p>');
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('useBlockRenderer', () => {
	function runRenderer(block: Ref<EditorBlock>, theme: Ref<Theme>) {
		const scope = effectScope();
		const api = scope.run(() => useBlockRenderer(block, { theme, debounceMs: 100 }))!;
		return { scope, ...api };
	}

	it('settles every one of 1,000 rapid renders and applies only the latest', async () => {
		const block = ref(makeBlock('same', 'v0'));
		const r = runRenderer(block, ref(makeTheme('#111')));

		const calls: Promise<void>[] = [];
		for (let i = 1; i <= 1000; i++) {
			block.value = makeBlock('same', `v${i}`);
			calls.push(r.render());
		}
		const settled = settledFlags(calls);
		await vi.advanceTimersByTimeAsync(100);
		await Promise.all(calls);

		expect(settled.every(Boolean)).toBe(true);
		expect(r.html.value).toBe('<p>same|v1000|#111</p>');
		expect(r.isRendering.value).toBe(false);
		expect(renderBlockFragment).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
		r.scope.stop();
	});

	it('keeps two instances with the same Block ID independent', async () => {
		const a = runRenderer(ref(makeBlock('same', 'a')), ref(makeTheme('#aaa')));
		const b = runRenderer(ref(makeBlock('same', 'b')), ref(makeTheme('#bbb')));
		const pendingA = a.render();
		await vi.advanceTimersByTimeAsync(50);
		const pendingB = b.render();
		await vi.advanceTimersByTimeAsync(100);
		await Promise.all([pendingA, pendingB]);

		expect(a.html.value).toBe('<p>same|a|#aaa</p>');
		expect(b.html.value).toBe('<p>same|b|#bbb</p>');
		a.scope.stop();
		b.scope.stop();
	});

	it('settles pending renders on disposal without updating state or leaving timers', async () => {
		const r = runRenderer(ref(makeBlock('gone', 'x')), ref(makeTheme('#111')));
		const pending = [r.render(), r.render()];
		const settled = settledFlags(pending);

		r.scope.stop();
		expect(vi.getTimerCount()).toBe(0);
		await Promise.all(pending);
		await vi.advanceTimersByTimeAsync(1000);

		expect(settled.every(Boolean)).toBe(true);
		expect(r.html.value).toBe('');
		expect(renderBlockFragment).not.toHaveBeenCalled();

		await r.render();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('does not write the legacy module cache', async () => {
		const r = runRenderer(ref(makeBlock('scoped-only', 'x')), ref(makeTheme('#111')));
		await vi.advanceTimersByTimeAsync(100);
		expect(r.html.value).toBe('<p>scoped-only|x|#111</p>');
		expect(getCachedHtml('scoped-only')).toBe('');
		r.scope.stop();
	});
});

describe('editor-scoped render cache', () => {
	// Plain apps are outside the setup's wrapper auto-unmount: each editor's app
	// is unmounted here and its host removed, also after a failed assertion.
	let apps: App[] = [];
	const hosts: HTMLElement[] = [];
	afterEach(() => {
		for (const app of apps) app.unmount();
		apps = [];
		for (const host of hosts.splice(0)) host.remove();
	});

	type Preview = ReturnType<typeof useBlockRenderer>;

	/** An "editor" that owns a cache and a list of previews it can mount. */
	function mountEditor() {
		const previews = ref<{ key: number; block: EditorBlock; theme: Theme }[]>([]);
		const mounted: Preview[] = [];
		let cache!: ReturnType<typeof provideBlockRenderCache>;
		const PreviewHost = defineComponent({
			props: { block: { type: Object, required: true }, theme: { type: Object, required: true } },
			setup(props) {
				const block = ref(props.block as EditorBlock);
				const theme = ref(props.theme as Theme);
				mounted.push(useBlockRenderer(block, { theme, debounceMs: 100 }));
				return () => h('div');
			},
		});
		const app = createApp({
			setup() {
				cache = provideBlockRenderCache();
				return () =>
					h(
						'div',
						previews.value.map((p) =>
							h(PreviewHost, { key: p.key, block: p.block, theme: p.theme })
						)
					);
			},
		});
		const host = document.createElement('div');
		document.body.appendChild(host);
		hosts.push(host);
		app.mount(host);
		apps.push(app);
		let nextKey = 0;
		return {
			app,
			mounted,
			get cache() {
				return cache;
			},
			async add(block: EditorBlock, theme: Theme): Promise<Preview> {
				previews.value = [...previews.value, { key: nextKey++, block, theme }];
				await vi.advanceTimersByTimeAsync(0);
				return mounted[mounted.length - 1]!;
			},
			async clear() {
				previews.value = [];
				await vi.advanceTimersByTimeAsync(0);
			},
		};
	}

	it('seeds a remounted preview in the same editor from that editor only', async () => {
		const block = makeBlock('dup', 'hello');
		const editorA = mountEditor();
		const editorB = mountEditor();

		const first = await editorA.add(block, makeTheme('#aaa'));
		await vi.advanceTimersByTimeAsync(100);
		expect(first.html.value).toBe('<p>dup|hello|#aaa</p>');

		// Same editor, same inputs: seeded immediately.
		const again = await editorA.add(block, makeTheme('#aaa'));
		expect(again.html.value).toBe('<p>dup|hello|#aaa</p>');

		// Another editor with the same Block ID and a different theme: never seeded.
		const other = await editorB.add(block, makeTheme('#bbb'));
		expect(other.html.value).toBe('');
		await vi.advanceTimersByTimeAsync(100);
		expect(other.html.value).toBe('<p>dup|hello|#bbb</p>');

		// Another editor with identical inputs is still not seeded across editors.
		const editorC = mountEditor();
		const third = await editorC.add(block, makeTheme('#aaa'));
		expect(third.html.value).toBe('');
	});

	it('does not seed when the theme or content changed since the cached render', async () => {
		const editor = mountEditor();
		await editor.add(makeBlock('blk', 'one'), makeTheme('#aaa'));
		await vi.advanceTimersByTimeAsync(100);
		await editor.clear();

		const otherTheme = await editor.add(makeBlock('blk', 'one'), makeTheme('#ccc'));
		expect(otherTheme.html.value).toBe('');
		const otherContent = await editor.add(makeBlock('blk', 'two'), makeTheme('#aaa'));
		expect(otherContent.html.value).toBe('');
	});

	it('releases the cache, cancels its previews and leaves no timer when the editor unmounts', async () => {
		const editor = mountEditor();
		const block = makeBlock('rel', 'x');
		const theme = makeTheme('#aaa');
		const preview = await editor.add(block, theme);
		await vi.advanceTimersByTimeAsync(100);
		expect(editor.cache.get(block, theme)).toBe('<p>rel|x|#aaa</p>');

		// A render still waiting when the editor goes away.
		const pending = preview.render();
		const settled = settledFlags([pending]);
		editor.app.unmount();
		apps = apps.filter((app) => app !== editor.app);

		expect(vi.getTimerCount()).toBe(0);
		await pending;
		expect(settled).toEqual([true]);
		expect(editor.cache.get(block, theme)).toBe('');
		editor.cache.set(block, theme, 'late');
		expect(editor.cache.get(block, theme)).toBe('');
		expect(preview.html.value).toBe('<p>rel|x|#aaa</p>');
	});
});
