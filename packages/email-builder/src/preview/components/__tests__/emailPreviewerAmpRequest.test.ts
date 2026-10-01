// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import EmailPreviewer from '../EmailPreviewer.vue';

/**
 * The previewer tells its host when AMP is needed (issue #923): only the AMP
 * view and the export menu read it, so the host renders AMP on request instead
 * of for every preview.
 */
let wrapper: VueWrapper | null = null;
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

const mountPreviewer = (props: Record<string, unknown> = {}) => {
	wrapper = mount(EmailPreviewer, {
		props: {
			html: '<html><body><p>Hi</p></body></html>',
			ampAvailable: true,
			autoAnalyze: false,
			showDeviceControls: false,
			...props,
		},
	});
	return wrapper;
};

const requests = (w: VueWrapper) =>
	(w.emitted('update:amp-requested') ?? []).map(([value]) => value);

const viewButton = (w: VueWrapper, label: string) =>
	w.findAll('.ep-view-btn').find((b) => b.text().includes(label))!;

describe('EmailPreviewer — AMP request signal', () => {
	it('does not request AMP for the HTML preview', () => {
		const w = mountPreviewer();
		expect(requests(w)).toEqual([]);
	});

	it('offers the AMP view before AMP exists and requests it on switch', async () => {
		const w = mountPreviewer();
		const amp = viewButton(w, 'AMP');
		expect(amp.exists()).toBe(true);

		await amp.trigger('click');
		expect(requests(w)).toEqual([true]);

		await viewButton(w, 'Preview').trigger('click');
		expect(requests(w)).toEqual([true, false]);
	});

	it('requests AMP while the export menu is open and exports the current AMP', async () => {
		const w = mountPreviewer();
		await w.find('.ep-export-wrapper .ep-control-btn').trigger('click');
		expect(requests(w)).toEqual([true]);
		// The host answers the request; the menu offers exactly that body.
		expect(w.text()).not.toContain('Download .amp.html');
		await w.setProps({ ampHtml: '<html ⚡4email>current</html>' });
		expect(w.text()).toContain('Download .amp.html');
	});

	it('hides the AMP view for hosts that do not render AMP', () => {
		const w = mountPreviewer({ ampAvailable: false });
		expect(viewButton(w, 'AMP')).toBeUndefined();
	});

	it('withdraws an open request when unmounted', async () => {
		// A listener prop, because the wrapper's emitted() history does not survive unmount.
		const seen: boolean[] = [];
		const w = mountPreviewer({ 'onUpdate:ampRequested': (value: boolean) => seen.push(value) });
		await viewButton(w, 'AMP').trigger('click');
		expect(seen).toEqual([true]);
		w.unmount();
		wrapper = null;
		expect(seen).toEqual([true, false]);
	});
});
