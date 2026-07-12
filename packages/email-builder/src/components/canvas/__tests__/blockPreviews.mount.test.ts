// @vitest-environment happy-dom
//
// Canvas rendering coverage for every registered block type.
//
// Each block is mounted through <DocumentBlock> — the exact dispatch the
// editor canvas uses — with the block's own registry `createDefault` content
// and the fully-populated default theme. A block that throws during render,
// resolves to nothing, or renders visually-empty output would previously slip
// through unit tests: the button block rendered fine under happy-dom while
// being invisible in real browsers (white text on a wiped background — see the
// background-shorthand regression below).
import { describe, it, expect, afterEach } from 'vitest';
import { createApp, h, type App } from 'vue';
import DocumentBlock from '../DocumentBlock.vue';
import DocumentCanvas from '../DocumentCanvas.vue';
import { getRegisteredTypes } from '../../../registry';
import { createBlock } from '../../../utils/blocks';
import { defaultTheme } from '../../../defaults';
import type { EditorBlock, EmailTheme, BlockType } from '../../../types';

// table / rawHtml / video / carousel render through <IframePreview>, which
// delegates to the real email renderer inside an <iframe srcdoc>. happy-dom
// does not execute srcdoc documents, so for these we assert the iframe shell
// mounts; their HTML output is covered by the renderer package's own tests.
const IFRAME_TYPES: ReadonlySet<string> = new Set(['table', 'rawHtml', 'video', 'carousel']);

let apps: App[] = [];
afterEach(() => {
	apps.forEach((a) => a.unmount());
	apps = [];
	document.body.innerHTML = '';
});

function mountBlock(block: EditorBlock): { host: HTMLElement; errors: unknown[] } {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const errors: unknown[] = [];
	const app = createApp({
		render: () => h(DocumentBlock, { block, theme: defaultTheme as Required<EmailTheme> }),
	});
	app.config.errorHandler = (err) => errors.push(err);
	app.config.warnHandler = () => {}; // extraneous-prop warnings are asserted elsewhere
	app.mount(host);
	apps.push(app);
	return { host, errors };
}

describe('every registered block type renders on the canvas', () => {
	const types = getRegisteredTypes();

	it('has the full built-in registry available', () => {
		expect(types.length).toBeGreaterThanOrEqual(17);
	});

	for (const type of getRegisteredTypes()) {
		it(`renders a default ${type} block without errors`, async () => {
			const block = createBlock(type as BlockType, defaultTheme);
			const { host, errors } = mountBlock(block);
			expect(errors).toEqual([]);
			if (IFRAME_TYPES.has(type)) {
				// Wait out the debounced renderBlockFragment call so the iframe /
				// empty-placeholder decision has settled.
				await new Promise((r) => setTimeout(r, 250));
				// A content-less default (video without URL, carousel without
				// images, comment-only rawHtml) must show the labelled
				// placeholder — never a zero-height invisible sliver.
				const iframe = host.querySelector('iframe');
				const placeholder = host.textContent?.includes('select to configure');
				expect(iframe || placeholder).toBeTruthy();
			} else {
				// Something visible must come out — an empty shell means the
				// canvas silently swallowed the block.
				expect(host.innerHTML.length).toBeGreaterThan(20);
			}
		});
	}

	it('shows the empty placeholder for a content-less video block, and a real iframe for a table', async () => {
		const video = createBlock('video', defaultTheme);
		const { host: videoHost } = mountBlock(video);
		const table = createBlock('table', defaultTheme);
		const { host: tableHost } = mountBlock(table);
		await new Promise((r) => setTimeout(r, 300));
		expect(videoHost.textContent).toContain('select to configure');
		expect(videoHost.querySelector('iframe')).toBeNull();
		expect(tableHost.querySelector('iframe')).toBeTruthy();
	});
});

describe('button block canvas regression (background shorthand wipe)', () => {
	// Vue's patchStyle turns `undefined` style values into '' — and assigning
	// '' to the `background` SHORTHAND clears the background-color longhand set
	// just before it. That left every button white-on-white in real browsers
	// (happy-dom's CSSOM doesn't emulate shorthand clearing, so we assert on
	// the serialized style attribute instead of computed style).
	it('emits background-color inline and never the background shorthand', () => {
		const block = createBlock('button', defaultTheme);
		const { host } = mountBlock(block);
		const span = host.querySelector('span');
		const style = span?.getAttribute('style') ?? '';
		expect(style).toContain('background-color');
		expect(style).not.toMatch(/(?:^|;)\s*background\s*:/);
	});

	it('uses backgroundImage (not the shorthand) for gradient fills', () => {
		const block = createBlock('button', defaultTheme);
		(block.content as Record<string, unknown>).backgroundGradient = {
			type: 'linear',
			angle: 90,
			stops: [
				{ color: '#ff0000', position: 0 },
				{ color: '#0000ff', position: 100 },
			],
		};
		const { host } = mountBlock(block);
		const style = host.querySelector('span')?.getAttribute('style') ?? '';
		expect(style).toContain('background-color');
		expect(style).toContain('background-image');
		expect(style).not.toMatch(/(?:^|;)\s*background\s*:/);
	});

	it('paints blockBackgroundColor on the wrapper, matching the renderer section band', () => {
		const block = createBlock('button', defaultTheme);
		(block.content as Record<string, unknown>).blockBackgroundColor = '#fef3c7';
		const { host } = mountBlock(block);
		const wrapper = host.querySelector('span')?.parentElement;
		expect(wrapper?.getAttribute('style') ?? '').toContain('background-color: #fef3c7');
	});
});

describe('social block edit↔render honesty', () => {
	// The renderer only emits icons with a URL; the default block has none, so
	// the canvas must flag that the icons won't be in the sent email.
	it('dims URL-less icons and shows the hint', () => {
		const block = createBlock('social', defaultTheme);
		const { host } = mountBlock(block);
		expect(host.textContent).toContain("won't appear in the sent email");
	});

	it('shows no hint once every enabled icon has a URL', () => {
		const block = createBlock('social', defaultTheme);
		const content = block.content as { links: { enabled: boolean; url: string }[] };
		content.links = content.links.map((l) => ({
			...l,
			url: l.enabled ? 'https://example.com' : l.url,
		}));
		const { host } = mountBlock(block);
		expect(host.textContent).not.toContain("won't appear in the sent email");
	});
});

describe('text block edit↔render typography parity', () => {
	it('renders headings bold when fontWeight is unset (matching UA rendering of the emitted <h2>)', () => {
		const block = createBlock('text', defaultTheme);
		Object.assign(block.content as Record<string, unknown>, { blockType: 'h2', html: 'Heading' });
		const { host } = mountBlock(block);
		const heading = host.querySelector('h2');
		expect(heading).toBeTruthy();
		expect(heading?.getAttribute('style') ?? '').toContain('font-weight: bold');
	});

	it('keeps paragraphs at normal weight', () => {
		const block = createBlock('text', defaultTheme);
		const { host } = mountBlock(block);
		const el = host.querySelector('.text-preview');
		expect(el?.getAttribute('style') ?? '').toContain('font-weight: normal');
	});

	it('applies theme headingDefaults like the render Walker does', () => {
		const themed = {
			...defaultTheme,
			headingDefaults: { h2: { fontWeight: 800, textColor: '#111111' } },
		} as Required<EmailTheme>;
		const block = createBlock('text', themed);
		Object.assign(block.content as Record<string, unknown>, {
			blockType: 'h2',
			html: 'Heading',
			textColor: undefined,
		});
		const host = document.createElement('div');
		document.body.appendChild(host);
		const app = createApp({
			render: () => h(DocumentBlock, { block, theme: themed }),
		});
		app.mount(host);
		apps.push(app);
		const style = host.querySelector('h2')?.getAttribute('style') ?? '';
		expect(style).toContain('font-weight: 800');
		expect(style).toContain('color: #111111');
	});
});

describe('DocumentCanvas renders the seeded demo template', () => {
	// Regression for the exact "Summer Sale" seed the button bug was reported
	// against: heading + paragraph + button must all reach the canvas.
	const blocks = JSON.parse(
		'[{"id":"t-1a","type":"text","content":{"html":"Summer Sale: 20% off everything","blockType":"h2","fontSize":24,"textColor":"#374151","lineHeight":1.3}},{"id":"t-1b","type":"text","content":{"html":"Hi there, our biggest discount of the season is live.","blockType":"paragraph","fontSize":16,"textColor":"#374151","lineHeight":1.5}},{"id":"t-1c","type":"button","content":{"text":"Shop the sale","url":"https://example.com/sale","backgroundColor":"#2563eb","textColor":"#ffffff","align":"center","borderRadius":6,"paddingX":24,"paddingY":12}}]'
	) as EditorBlock[];

	it('renders all three blocks with a visible button fill', () => {
		const host = document.createElement('div');
		document.body.appendChild(host);
		const errors: unknown[] = [];
		const app = createApp({
			render: () =>
				h(DocumentCanvas, {
					blocks,
					selectedBlockId: null,
					theme: defaultTheme as Required<EmailTheme>,
				}),
		});
		app.config.errorHandler = (err) => errors.push(err);
		app.mount(host);
		apps.push(app);
		expect(errors).toEqual([]);
		expect(host.textContent).toContain('Summer Sale');
		expect(host.textContent).toContain('Shop the sale');
		const buttonSpan = host.querySelector('[data-block-id="t-1c"] span');
		expect(buttonSpan?.getAttribute('style') ?? '').toContain('background-color: #2563eb');
	});
});
