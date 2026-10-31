/**
 * The visualization frame reports its own height; content sized against the
 * frame (vh, %) grows with every report, so the host ignores sub-pixel changes
 * and caps the height instead of growing the card forever.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import VisualizationRenderer from '../VisualizationRenderer.vue';

function mountRenderer() {
	return mount(VisualizationRenderer, {
		props: { html: '<html><body><div>chart</div></body></html>', minHeight: '180px' },
		attachTo: document.body,
	});
}

async function report(frame: HTMLIFrameElement, height: unknown) {
	window.dispatchEvent(
		new MessageEvent('message', {
			data: { type: 'resize', height },
			source: frame.contentWindow,
		})
	);
	await nextTick();
}

describe('VisualizationRenderer resize reports', () => {
	it('follows reported heights from its own frame', async () => {
		const w = mountRenderer();
		const frame = w.find('iframe').element as HTMLIFrameElement;
		await report(frame, 420);
		expect(frame.style.height).toBe('420px');
		w.unmount();
	});

	it('caps a runaway height', async () => {
		const w = mountRenderer();
		const frame = w.find('iframe').element as HTMLIFrameElement;
		await report(frame, 250_000);
		expect(frame.style.height).toBe('4000px');
		w.unmount();
	});

	it('ignores sub-pixel changes and nonsense values', async () => {
		const w = mountRenderer();
		const frame = w.find('iframe').element as HTMLIFrameElement;
		await report(frame, 500);
		await report(frame, 500.4);
		expect(frame.style.height).toBe('500px');
		await report(frame, Number.NaN);
		await report(frame, -20);
		await report(frame, '900');
		expect(frame.style.height).toBe('500px');
		w.unmount();
	});

	it('ignores messages from other windows', async () => {
		const w = mountRenderer();
		const frame = w.find('iframe').element as HTMLIFrameElement;
		window.dispatchEvent(
			new MessageEvent('message', { data: { type: 'resize', height: 999 }, source: window })
		);
		await nextTick();
		expect(frame.style.height).toBe('180px');
		w.unmount();
	});
});

describe('VisualizationRenderer injected resize script', () => {
	function framedDocument(html: string) {
		const w = mount(VisualizationRenderer, { props: { html } });
		const srcdoc = w.find('iframe').attributes('srcdoc') ?? '';
		w.unmount();
		return { srcdoc, doc: new DOMParser().parseFromString(srcdoc, 'text/html') };
	}

	it('closes the script it adds before the body ends', () => {
		const { srcdoc, doc } = framedDocument('<html><body><div>chart</div></body></html>');
		expect(srcdoc).toMatch(/report\(\);\n\}\)\(\);\n<\/script><\/body><\/html>$/);
		const scripts = doc.querySelectorAll('body > script');
		expect(scripts).toHaveLength(1);
		expect(scripts[0]!.textContent).toContain('new ResizeObserver(report)');
		expect(doc.body.querySelector('div')?.textContent).toBe('chart');
	});

	it('appends a closed script to markup without a body', () => {
		const { srcdoc } = framedDocument('<div>chart</div>');
		expect(srcdoc.startsWith('<div>chart</div>')).toBe(true);
		expect(srcdoc.endsWith('</script>')).toBe(true);
		expect(srcdoc.match(/<script>/g)).toHaveLength(1);
	});
});
