// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { CanIEmailData, CanIEmailFeature, EmailClient } from '../../types';

/**
 * Issue #1435: the Compatibility tab tells "no client picked" apart from "picked,
 * still analyzing", a failed analysis and a manual analysis not yet run, and
 * never shows one client's report as another's.
 */
const SELECT_PROMPT = 'Select a client above to analyze compatibility.';

const snapshot = (data: CanIEmailFeature[] = []): CanIEmailData => ({
	api_version: '1.0',
	last_update_date: '2026-06-03',
	nicenames: { family: {}, platform: {}, support: {}, category: {} },
	data,
});

let wrapper: VueWrapper | null = null;
let respond!: (data?: CanIEmailData) => void;

// The bundled Can I Email snapshot is held until `respond()`: a slow first load.
const loadSnapshot = vi.hoisted(() => vi.fn());
vi.mock('../../composables/caniemailSnapshot', () => ({ loadCanIEmailSnapshot: loadSnapshot }));

beforeEach(() => {
	loadSnapshot.mockReset();
	loadSnapshot.mockImplementation(
		() =>
			new Promise<CanIEmailData>((resolve) => {
				respond = (data = snapshot()) => resolve(data);
			})
	);
});
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

// A fresh module graph per test: the Can I Email cache is module-level.
async function mountPreviewer(props: Record<string, unknown> = {}) {
	vi.resetModules();
	const { default: EmailPreviewer } = await import('../EmailPreviewer.vue');
	const { default: ClientSelector } = await import('../ClientSelector.vue');
	const { emailClients } = await import('../../data/clients');
	wrapper = mount(EmailPreviewer, {
		props: {
			html: '<div style="display: grid"></div>',
			autoAnalyze: true,
			// Keeps the analysis panel on screen without a client.
			validationIssues: [{ severity: 'warning', code: 'footer', message: 'Check the footer' }],
			...props,
		},
	});
	// The analysis panel loads with its first render (lazyPanels.ts).
	await vi.dynamicImportSettled();
	await flushPromises();
	const w = wrapper;
	await w.find('.ep-analysis-header').trigger('click');
	const compatibilityTab = w.findAll('.ep-analysis-tab').find((t) => t.text() === 'Compatibility');
	await compatibilityTab!.trigger('click');
	const selector = w.findComponent(ClientSelector);
	const client = (id: string) => {
		const found = emailClients.find((c) => c.id === id);
		if (!found) throw new Error(`unknown client ${id}`);
		return found;
	};
	return {
		w,
		client,
		select: async (c: EmailClient | null) => {
			selector.vm.$emit('update:selectedClient', c);
			await flushPromises();
		},
		tab: () => w.find('.ep-analysis-section'),
	};
}

describe('EmailPreviewer — Compatibility tab states', () => {
	it('shows loading, not the select prompt, while the selected client is analyzed', async () => {
		const { select, client, tab } = await mountPreviewer();
		expect(tab().text()).toBe(SELECT_PROMPT);

		await select(client('gmail-webmail'));
		const pending = tab().find('[role="status"]');
		expect(pending.exists()).toBe(true);
		expect(pending.text()).toBe('Checking compatibility with Gmail (Web)…');
		expect(tab().text()).not.toContain(SELECT_PROMPT);

		respond();
		await flushPromises();
		expect(tab().find('[role="status"]').exists()).toBe(false);
		expect(tab().find('.ep-compat-score').text()).toContain('Gmail (Web)');
		expect(tab().text()).toContain('css-display-grid');

		await select(null);
		expect(tab().text()).toBe(SELECT_PROMPT);
	});

	it('shows a failure, with the reason, when the analysis fails', async () => {
		const { select, client, tab } = await mountPreviewer();
		await select(client('gmail-webmail'));
		// A feature without stats makes the support lookup throw mid-analysis.
		respond(snapshot([{ slug: 'css-display-grid', title: 'Grid' } as unknown as CanIEmailFeature]));
		await flushPromises();

		const failed = tab().find('[role="alert"]');
		expect(failed.exists()).toBe(true);
		expect(failed.text()).toBe(
			'Could not check compatibility with Gmail (Web). Refresh the preview to try again.'
		);
		expect(failed.attributes('title')).toBeTruthy();
		expect(tab().text()).not.toContain(SELECT_PROMPT);

		// The failure belongs to the analysis that failed: clearing the client drops it.
		await select(null);
		expect(tab().find('[role="alert"]').exists()).toBe(false);
		expect(tab().text()).toBe(SELECT_PROMPT);
	});

	it('with autoAnalyze off, asks for a refresh and never shows the previous client’s report', async () => {
		const { w, select, client, tab } = await mountPreviewer({ autoAnalyze: false });
		await select(client('gmail-webmail'));
		expect(tab().text()).toBe('Refresh the preview to check compatibility with Gmail (Web).');

		await w.find('button[title="Refresh preview"]').trigger('click');
		expect(tab().find('[role="status"]').text()).toBe('Checking compatibility with Gmail (Web)…');
		respond();
		await flushPromises();
		expect(tab().find('.ep-compat-score').text()).toContain('Gmail (Web)');

		await select(client('outlook-windows'));
		expect(tab().find('.ep-compat-score').exists()).toBe(false);
		expect(tab().text()).toBe('Refresh the preview to check compatibility with Outlook (Windows).');
	});
});
