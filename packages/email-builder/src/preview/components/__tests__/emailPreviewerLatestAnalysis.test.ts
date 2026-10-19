// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { CompatibilityReport } from '../../types';

/**
 * The previewer re-runs compatibility analysis on every html/client change.
 * While the first caniemail load is slow, only the newest analysis may reach
 * the host, and nothing may arrive after the previewer is gone.
 */
let wrapper: VueWrapper | null = null;
let respond!: () => void;

beforeEach(() => {
	// The composable also caches the data in localStorage; start every test cold.
	localStorage.clear();
	vi.stubGlobal(
		'fetch',
		vi.fn(
			() =>
				new Promise((resolve) => {
					respond = () =>
						resolve({
							ok: true,
							statusText: 'OK',
							json: async () => ({
								api_version: '1.0',
								last_update_date: '2026-06-03',
								nicenames: { family: {}, platform: {}, support: {}, category: {} },
								data: [],
							}),
						});
				})
		)
	);
});
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
	vi.unstubAllGlobals();
});

// A fresh module graph per test: the caniemail cache is module-level.
async function mountPreviewer(onReport: (report: CompatibilityReport) => void) {
	vi.resetModules();
	const { default: EmailPreviewer } = await import('../EmailPreviewer.vue');
	const { default: ClientSelector } = await import('../ClientSelector.vue');
	const { emailClients } = await import('../../data/clients');
	wrapper = mount(EmailPreviewer, {
		props: {
			html: '<div style="display: flex"></div>',
			autoAnalyze: true,
			onCompatibilityReport: onReport,
		},
	});
	// Picking a client is what starts an analysis.
	wrapper.findComponent(ClientSelector).vm.$emit('update:selectedClient', emailClients[0]);
	await flushPromises();
	return wrapper;
}

const features = (report: CompatibilityReport) => report.issues.map((i) => i.feature);

describe('EmailPreviewer — latest-only compatibility analysis', () => {
	it('emits one report, for the newest html, when an edit lands during the first load', async () => {
		const reports: CompatibilityReport[] = [];
		const w = await mountPreviewer((r) => reports.push(r));
		await w.setProps({ html: '<div style="display: grid"></div>' });

		respond();
		await flushPromises();

		expect(reports).toHaveLength(1);
		expect(features(reports[0]!)).toContain('css-display-grid');
		expect(features(reports[0]!)).not.toContain('css-display-flex');
	});

	it('emits nothing once unmounted mid-analysis', async () => {
		const reports: CompatibilityReport[] = [];
		const w = await mountPreviewer((r) => reports.push(r));
		w.unmount();
		wrapper = null;

		respond();
		await flushPromises();

		expect(reports).toEqual([]);
	});
});
