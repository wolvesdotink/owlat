/**
 * The click heatmap walks every link in the campaign HTML: tracking, mail,
 * phone, anchor and unsubscribe links are skipped, and each remaining link is
 * marked in the preview with its position among ALL links, so a skipped link
 * must neither stop the walk nor shift the marks after it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ClickHeatmap from '../ClickHeatmap.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const stubs = { Icon: { template: '<i />' }, UiIconBox: { template: '<i />' } };

function mountHeatmap(htmlContent: string) {
	return mount(ClickHeatmap, {
		props: {
			htmlContent,
			linkStats: [
				{ url: 'https://owlat.example/pricing', clicks: 4, uniqueClickers: 3 },
				{ url: 'https://owlat.example/docs', clicks: 1, uniqueClickers: 1 },
			],
			totalDelivered: 10,
		},
		global: { plugins: [createTestI18n()], stubs },
	});
}

describe('ClickHeatmap link walk', () => {
	it('keeps walking past skipped links and marks each kept link by its position', () => {
		const w = mountHeatmap(
			[
				'<a href="#top">Top</a>',
				'<a href="https://owlat.example/pricing">Pricing</a>',
				'<a href="mailto:hello@owlat.example">Mail us</a>',
				'<a href="https://owlat.example/t/c/abc">Tracked</a>',
				'<a href="https://owlat.example/docs">Docs</a>',
				'<a href="https://owlat.example/unsubscribe">Unsubscribe</a>',
			].join('')
		);

		const rows = w.findAll('a[target="_blank"]').map((a) => a.attributes('href'));
		expect(rows).toEqual(['https://owlat.example/pricing', 'https://owlat.example/docs']);

		const preview = new DOMParser().parseFromString(
			w.find('iframe').attributes('srcdoc') ?? '',
			'text/html'
		);
		const marked = [...preview.querySelectorAll('a[data-heatmap-link]')].map((a) => [
			a.getAttribute('href'),
			a.getAttribute('data-heatmap-link'),
		]);
		expect(marked).toEqual([
			['https://owlat.example/pricing', '1'],
			['https://owlat.example/docs', '4'],
		]);
		w.unmount();
	});
});
