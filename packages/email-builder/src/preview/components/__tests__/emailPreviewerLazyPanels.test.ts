// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { diffEmails } from '@owlat/email-renderer';
import EmailPreviewer from '../EmailPreviewer.vue';

/**
 * The analysis, render-options and diff panels load with their first render,
 * not with the previewer (plan item OW-060). The bundler keeps a module out of
 * its importer's chunk only while every import of it is dynamic, so the module
 * graph is the oracle here; the panels must still open, work and keep focus.
 */
const SRC = join(__dirname, '../../..');
const PANELS = ['AnalysisPanel', 'RenderOptionsPanel', 'DiffPanel'];

const sourceFiles = (dir: string): string[] =>
	readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
		return /\.(ts|vue)$/.test(name) ? [path] : [];
	});

let wrapper: VueWrapper | null = null;
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
	document.body.innerHTML = '';
});

const mountPreviewer = (props: Record<string, unknown> = {}) => {
	wrapper = mount(EmailPreviewer, {
		props: {
			html: '<html><body><p>Hello</p></body></html>',
			autoAnalyze: false,
			showDeviceControls: false,
			...props,
		},
		attachTo: document.body,
	});
	return wrapper;
};

/** Let the panel chunk resolve and the async wrapper re-render. */
const settle = async () => {
	await vi.dynamicImportSettled();
	await flushPromises();
};

describe('EmailPreviewer — lazily loaded panels', () => {
	it('no source module imports a panel statically', () => {
		const offenders = sourceFiles(SRC).flatMap((file) => {
			const text = readFileSync(file, 'utf8');
			return PANELS.filter((panel) =>
				new RegExp(`(?:from|import)\\s*['"][^'"]*/${panel}\\.vue['"]`).test(text)
			).map((panel) => `${relative(SRC, file)} → ${panel}`);
		});
		expect(offenders).toEqual([]);
		// The one place each panel is reached from is a dynamic import.
		const lazy = readFileSync(join(__dirname, '../lazyPanels.ts'), 'utf8');
		for (const panel of PANELS) expect(lazy).toContain(`import('./${panel}.vue')`);
	});

	it('opens render options from the gear and keeps focus on it', async () => {
		const w = mountPreviewer({ renderOptions: { baseWidth: 640 } });
		const gear = w.find<HTMLButtonElement>('button[aria-label="Render options"]');
		gear.element.focus();
		await gear.trigger('click');
		await settle();

		const panel = w.find('.ep-settings-panel');
		expect(panel.exists()).toBe(true);
		expect(document.activeElement).toBe(gear.element);

		// Behaviour once loaded is unchanged: options in, updates out, close.
		const width = panel.find<HTMLInputElement>('input[type="number"]');
		expect(width.element.value).toBe('640');
		await width.setValue('700');
		await width.trigger('change');
		expect(w.emitted('update:render-options')?.at(-1)?.[0]).toMatchObject({ baseWidth: 700 });
		await panel.find('.ep-settings-close').trigger('click');
		expect(w.find('.ep-settings-panel').exists()).toBe(false);
	});

	it('opens the diff from its button and keeps focus on it', async () => {
		const diff = diffEmails(
			'<html><body><p>Hi</p></body></html>',
			'<html><body><p>Hello</p></body></html>'
		);
		const w = mountPreviewer({ emailDiff: diff });
		const button = w.find<HTMLButtonElement>('button[aria-label="Compare changes"]');
		button.element.focus();
		await button.trigger('click');
		await settle();

		expect(w.find('.ep-diff-panel').text()).toContain(diff.changes[0]!.description);
		expect(document.activeElement).toBe(button.element);
		await w.find('.ep-diff-close').trigger('click');
		expect(w.find('.ep-diff-panel').exists()).toBe(false);
	});

	it('shows the analysis bar once there is data and expands it', async () => {
		const w = mountPreviewer({
			validationIssues: [{ severity: 'warning', message: 'Check the footer' }],
		});
		await settle();

		expect(w.find('.ep-analysis-panel').exists()).toBe(true);
		expect(w.find('.ep-analysis-body').exists()).toBe(false);
		await w.find('.ep-analysis-header').trigger('click');
		expect(w.find('.ep-analysis-body').exists()).toBe(true);
	});
});
