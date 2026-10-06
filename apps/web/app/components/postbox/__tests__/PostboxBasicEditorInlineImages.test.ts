// @vitest-environment happy-dom
/**
 * #1285: an image pasted into a draft's body, once the draft is reopened.
 *
 * The body used to be saved with the paste's `blob:` preview as the image's
 * src. That URL dies with the tab, so a reload or another device showed a
 * broken image. Now the editor saves the image as `<img data-inline-cid="X">`
 * with no src, and fills one in from `inlineImageSources` (an expiring URL
 * for the row part) after every write of the body, including bodies an older client
 * saved with the dead `blob:` URL. The composer renews those URLs before they
 * expire (`usePostboxDraftInlineImages`), and the editor follows.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { nextTick, onBeforeMount, onBeforeUnmount } from 'vue';
import { mount } from '@vue/test-utils';

import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('onBeforeMount', onBeforeMount);
	vi.stubGlobal('onBeforeUnmount', onBeforeUnmount);
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('requireConvex', () => ({ action: vi.fn() }));
});

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const { default: PostboxBasicEditor } = await import('../PostboxBasicEditor.vue');

const CID = 'chart@owlat.inline';
const ROW_URL = 'https://deploy.convex.site/sealed-blob?id=chart&ct=image%2Fpng&exp=1&sig=x';
const DEAD_BLOB = 'blob:https://app.owlat.example/0b6f4d1e-7a1c-4a52-9a0e-3f1d2c5b8e77';
/** What the editor saves since #1285. */
const STORED = `<p>Chart:</p><p><img data-inline-cid="${CID}" style="max-width:100%;height:auto"></p>`;
/** What it saved before: the session's preview as the src. */
const STORED_BEFORE_1285 = `<p>Chart:</p><p><img src="${DEAD_BLOB}" data-inline-cid="${CID}"></p>`;

/** The URLs the composer hands the editor for one draft. */
const sourcesOf = (scope: string, url?: string) => ({
	scope,
	urls: new Map(url ? [[CID, url]] : []),
});

function mountEditor(props: Record<string, unknown>) {
	return mount(PostboxBasicEditor, {
		props: { inlineImagesEnabled: true, ...props },
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			stubs: {
				PostboxEditorToolbar: true,
				PostboxFloatingFormatBar: true,
				PostboxRewriteLayer: true,
				PostboxEmojiPicker: true,
				PostboxSnippetSurface: true,
				Icon: { props: ['name'], template: '<span />' },
			},
		},
	});
}

const editorOf = (w: ReturnType<typeof mountEditor>) =>
	w.get('[contenteditable]').element as HTMLElement;
const imageSrc = (w: ReturnType<typeof mountEditor>) =>
	editorOf(w).querySelector(`img[data-inline-cid="${CID}"]`)?.getAttribute('src') ?? null;

/** Type at the end of the body, as the input event the editor listens to. */
async function typeAtEnd(w: ReturnType<typeof mountEditor>, text: string) {
	editorOf(w).querySelector('p')!.append(text);
	await w.get('[contenteditable]').trigger('input');
}

const lastEmitted = (w: ReturnType<typeof mountEditor>) => {
	const updates = w.emitted('update:modelValue') ?? [];
	return updates.at(-1)?.[0] as string | undefined;
};

describe('PostboxBasicEditor: inline images of a reopened draft', () => {
	it("shows the image from the row part's URL", () => {
		const w = mountEditor({
			modelValue: STORED,
			inlineImageSources: sourcesOf('draft_a', ROW_URL),
		});
		expect(imageSrc(w)).toBe(ROW_URL);
		w.unmount();
	});

	it('replaces the dead blob: src of a body saved before #1285', () => {
		const w = mountEditor({
			modelValue: STORED_BEFORE_1285,
			inlineImageSources: sourcesOf('draft_a', ROW_URL),
		});
		expect(imageSrc(w)).toBe(ROW_URL);
		w.unmount();
	});

	it('fills the image in when the URLs arrive after the body', async () => {
		const w = mountEditor({ modelValue: STORED_BEFORE_1285 });
		expect(imageSrc(w)).toBe(DEAD_BLOB);

		await w.setProps({ inlineImageSources: sourcesOf('draft_a', ROW_URL) });
		expect(imageSrc(w)).toBe(ROW_URL);
		w.unmount();
	});

	it('moves the image to a renewed URL before the old one expires', async () => {
		const w = mountEditor({
			modelValue: STORED,
			inlineImageSources: sourcesOf('draft_a', ROW_URL),
		});
		const renewed = `${ROW_URL}?exp=2`;
		await w.setProps({ inlineImageSources: sourcesOf('draft_a', renewed) });
		expect(imageSrc(w)).toBe(renewed);
		w.unmount();
	});

	it("takes draft A's URL off the image when the editor moves on to draft B", async () => {
		const w = mountEditor({
			modelValue: STORED,
			inlineImageSources: sourcesOf('draft_a', ROW_URL),
		});
		expect(imageSrc(w)).toBe(ROW_URL);

		// Same saved HTML, same Content-ID; B's lookup has not answered yet.
		await w.setProps({ inlineImageSources: sourcesOf('draft_b') });
		expect(imageSrc(w)).toBeNull();
		// Nor once it answers with nothing.
		await w.setProps({ inlineImageSources: { scope: 'draft_b', urls: new Map() } });
		expect(imageSrc(w)).toBeNull();
		// The saved body was never touched by any of it.
		await typeAtEnd(w, ' Thanks!');
		expect(lastEmitted(w)).not.toContain('src=');

		const B_URL = `${ROW_URL}&draft=b`;
		await w.setProps({ inlineImageSources: sourcesOf('draft_b', B_URL) });
		expect(imageSrc(w)).toBe(B_URL);
		w.unmount();
	});

	it('fills it in for a draft the body reaches only after mount (hydration)', async () => {
		const w = mountEditor({ modelValue: '', inlineImageSources: sourcesOf('draft_a', ROW_URL) });
		await w.setProps({ modelValue: STORED_BEFORE_1285 });
		expect(imageSrc(w)).toBe(ROW_URL);
		w.unmount();
	});

	it('never saves a src for the image, whatever it shows', async () => {
		const w = mountEditor({
			modelValue: STORED_BEFORE_1285,
			inlineImageSources: sourcesOf('draft_a', ROW_URL),
		});
		await typeAtEnd(w, ' Thanks!');

		const saved = lastEmitted(w)!;
		expect(saved).toContain(`data-inline-cid="${CID}"`);
		expect(saved).toContain('Thanks!');
		expect(saved).not.toContain('src=');
		expect(saved).not.toContain('blob:');
		// The editor still shows it.
		expect(imageSrc(w)).toBe(ROW_URL);
		w.unmount();
	});

	it("never saves a fresh paste's blob: preview either", async () => {
		const w = mountEditor({ modelValue: '<p>Chart:</p>' });
		const img = document.createElement('img');
		img.src = 'blob:https://app.owlat.example/fresh-preview';
		img.setAttribute('data-inline-cid', CID);
		editorOf(w).append(img);
		await w.get('[contenteditable]').trigger('input');

		expect(lastEmitted(w)).toContain(`data-inline-cid="${CID}"`);
		expect(lastEmitted(w)).not.toContain('blob:');
		w.unmount();
	});

	it('keeps showing the image when the body is written from outside (a share link)', async () => {
		const w = mountEditor({
			modelValue: STORED,
			inlineImageSources: sourcesOf('draft_a', ROW_URL),
		});
		await typeAtEnd(w, ' Thanks!');
		await w.setProps({ modelValue: lastEmitted(w)! });
		await w.setProps({ modelValue: `${lastEmitted(w)}<p>Link: report.pdf</p>` });
		await nextTick();

		expect(editorOf(w).textContent).toContain('Link: report.pdf');
		expect(imageSrc(w)).toBe(ROW_URL);
		w.unmount();
	});
});
