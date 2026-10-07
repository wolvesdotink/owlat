// @vitest-environment happy-dom
/**
 * "Preview as sent" shows a pasted image from the URL the editor has for the
 * draft's part (#1301). The body keeps such an image as `<img data-inline-cid>`
 * with no src, and the renderer drops the marker, so without the composer's
 * URLs the preview frame had only a broken image to show.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxPreviewAsSent from '../PostboxPreviewAsSent.vue';

const URL_LOGO = 'https://api.owlat.example/sealed-blob?id=s1&exp=1&sig=x';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

function srcdocOf(inlineImageSources?: { scope: string; urls: Map<string, string> }) {
	const wrapper = mount(PostboxPreviewAsSent, {
		props: {
			open: true,
			subject: 'Our logo',
			bodyHtml: '<p>Logo:</p><p><img data-inline-cid="logo@owlat" alt="logo.png"></p>',
			bodyBlocks: [],
			composerMode: 'simple',
			inlineImageSources,
		},
		global: {
			plugins: [createTestI18n()],
			stubs: { UiModal: { template: '<div><slot /></div>' } },
		},
	});
	const srcdoc = wrapper.get('iframe').attributes('srcdoc') ?? '';
	wrapper.unmount();
	return srcdoc;
}

describe('PostboxPreviewAsSent', () => {
	it("shows a pasted image from the composer's URL for its part", () => {
		const srcdoc = srcdocOf({ scope: 'c1', urls: new Map([['logo@owlat', URL_LOGO]]) });
		expect(srcdoc).toContain(`src="${URL_LOGO.replace(/&/g, '&amp;')}"`);
	});

	it('shows it without a src while its URL is not known', () => {
		const img = /<img\b[^>]*>/.exec(srcdocOf())?.[0] ?? '';
		expect(img).toContain('alt="logo.png"');
		expect(img).not.toContain('src=');
	});
});
