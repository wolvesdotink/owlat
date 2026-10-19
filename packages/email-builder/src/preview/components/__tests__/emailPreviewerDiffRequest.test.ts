// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { diffEmails } from '@owlat/email-renderer';
import EmailPreviewer from '../EmailPreviewer.vue';
import PreviewPanel from '../../../components/PreviewPanel.vue';

/**
 * The previewer tells its host while the diff panel is open, so the host diffs
 * on request instead of after every render. The host's cheap "HTML changed"
 * signal keeps the Diff button where the computed diff used to put it.
 */
let wrapper: VueWrapper | null = null;
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

const before = '<html><body><p>Hi</p></body></html>';
const after = '<html><body><p>Hello</p></body></html>';

const mountPreviewer = (props: Record<string, unknown> = {}) => {
	wrapper = mount(EmailPreviewer, {
		props: {
			html: after,
			autoAnalyze: false,
			showDeviceControls: false,
			...props,
		},
	});
	return wrapper;
};

const requests = (w: VueWrapper) =>
	(w.emitted('update:diff-requested') ?? []).map(([value]) => value);

/** The preview's panels load with their first render (lazyPanels.ts). */
const settlePanels = async () => {
	await vi.dynamicImportSettled();
	await flushPromises();
};

const diffButton = (w: VueWrapper) => w.find('button[title="Compare changes"]');

describe('EmailPreviewer — diff request signal', () => {
	it('offers no diff and requests none without a change', () => {
		const w = mountPreviewer();
		expect(diffButton(w).exists()).toBe(false);
		expect(requests(w)).toEqual([]);
	});

	it('offers the diff before it exists and requests it while the panel is open', async () => {
		const w = mountPreviewer({ diffAvailable: true });
		expect(diffButton(w).exists()).toBe(true);
		expect(requests(w)).toEqual([]);

		await diffButton(w).trigger('click');
		expect(requests(w)).toEqual([true]);
		// The panel loads lazily: let any chunk settle so its absence is real.
		await settlePanels();
		expect(w.find('.ep-diff-panel').exists()).toBe(false);

		// The host answers the request; the panel shows exactly that diff.
		const diff = diffEmails(before, after);
		await w.setProps({ emailDiff: diff });
		await settlePanels();
		expect(w.find('.ep-diff-panel').exists()).toBe(true);
		expect(w.find('.ep-diff-panel').text()).toContain(diff.changes[0]!.description);

		await diffButton(w).trigger('click');
		expect(requests(w)).toEqual([true, false]);
	});

	it('keeps the button rule for hosts that pass a computed diff', async () => {
		const w = mountPreviewer({ emailDiff: diffEmails(before, after) });
		expect(diffButton(w).exists()).toBe(true);
		await w.setProps({ emailDiff: diffEmails(after, after) });
		expect(diffButton(w).exists()).toBe(false);
	});

	it('withdraws an open request when unmounted', async () => {
		// A listener prop, because the wrapper's emitted() history does not survive unmount.
		const seen: boolean[] = [];
		const w = mountPreviewer({
			diffAvailable: true,
			'onUpdate:diffRequested': (value: boolean) => seen.push(value),
		});
		await diffButton(w).trigger('click');
		expect(seen).toEqual([true]);
		w.unmount();
		wrapper = null;
		expect(seen).toEqual([true, false]);
	});

	it('is passed through the builder preview panel', async () => {
		wrapper = mount(PreviewPanel, { props: { html: after, diffAvailable: true } });
		await diffButton(wrapper).trigger('click');
		expect(wrapper.emitted('update:diff-requested')).toEqual([[true]]);
	});
});
