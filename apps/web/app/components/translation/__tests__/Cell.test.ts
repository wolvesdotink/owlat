/**
 * Translation table cell, keyboard and focus (issue #1007). Every editable cell
 * used to be a click-only div: Tab skipped it and the editor could only be
 * opened with a mouse. The cell is mounted into the live document and driven
 * with real key events, for empty and filled cells and for plain-text and HTML
 * rows.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import TranslationCell from '../Cell.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { auditA11y } from '~/__tests__/a11y';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const stubs = { UiSpinner: { template: '<span data-testid="spinner" />' } };

let wrapper: VueWrapper | null = null;
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

function mountCell(props: Record<string, unknown>) {
	wrapper = mount(TranslationCell, {
		props: { fieldLabel: 'Subject line', languageLabel: 'Deutsch', ...props },
		attachTo: document.body,
		global: { plugins: [createTestI18n()], stubs },
	});
	return wrapper;
}

const entry = (w: VueWrapper) => w.get('button');

const CASES = [
	{ name: 'empty plain-text cell', value: '', isHtml: false },
	{ name: 'filled plain-text cell', value: 'Hallo', isHtml: false },
	{ name: 'empty HTML cell', value: '', isHtml: true },
	{ name: 'filled HTML cell', value: '<p>Hallo <strong>Welt</strong></p>', isHtml: true },
];

describe.each(CASES)('$name', ({ value, isHtml }) => {
	it('is a named, focusable button that Enter opens', async () => {
		const w = mountCell({ value, isHtml });
		const button = entry(w);
		expect(button.attributes('type')).toBe('button');
		expect(button.attributes('aria-label')).toBe('Edit Subject line (Deutsch)');

		(button.element as HTMLButtonElement).focus();
		expect(document.activeElement).toBe(button.element);
		// A native button turns Enter and Space into a click.
		await button.trigger('click');
		await nextTick();
		await nextTick();

		const textarea = w.get('textarea');
		expect(textarea.attributes('aria-label')).toBe('Subject line (Deutsch)');
		expect(document.activeElement).toBe(textarea.element);
		expect((textarea.element as HTMLTextAreaElement).value).toBe(value);
	});

	it('Escape cancels and returns focus to the same cell', async () => {
		const w = mountCell({ value, isHtml });
		await entry(w).trigger('click');
		await nextTick();
		const textarea = w.get('textarea');
		await textarea.setValue('Geändert');
		await textarea.trigger('keydown', { key: 'Escape' });
		await nextTick();
		await nextTick();

		expect(w.find('textarea').exists()).toBe(false);
		expect(w.emitted('save')).toBeUndefined();
		expect(document.activeElement).toBe(entry(w).element);
	});

	it('Ctrl+Enter saves and returns focus to the same cell', async () => {
		const w = mountCell({ value, isHtml });
		await entry(w).trigger('click');
		await nextTick();
		const textarea = w.get('textarea');
		await textarea.setValue('Neu');
		await textarea.trigger('keydown', { key: 'Enter', ctrlKey: true });
		await nextTick();
		await nextTick();

		expect(w.emitted('save')).toEqual([['Neu']]);
		expect(document.activeElement).toBe(entry(w).element);
	});
});

describe('TranslationCell', () => {
	it('keeps the source cell read-only, with no control to enter', () => {
		const w = mountCell({ value: 'Hello', isDefault: true });
		expect(w.find('button').exists()).toBe(false);
		expect(w.find('[tabindex]').exists()).toBe(false);
		expect(w.text()).toContain('Hello');
	});

	it('reports the text open in the editor, and null once it closes', async () => {
		const w = mountCell({ value: 'Hallo' });
		await entry(w).trigger('click');
		await nextTick();
		await w.get('textarea').setValue('Hallo!');
		await w.get('textarea').trigger('keydown', { key: 'Escape' });
		await nextTick();

		const reports = w.emitted('edit')!.map(([text]) => text);
		expect(reports).toContain('Hallo!');
		expect(reports.at(-1)).toBeNull();
	});

	it('withdraws its open text when it is removed while editing', async () => {
		const w = mountCell({ value: 'Hallo' });
		await entry(w).trigger('click');
		await nextTick();
		await w.get('textarea').setValue('Hallo!');
		await nextTick();
		expect(w.emitted('edit')!.at(-1)).toEqual(['Hallo!']);

		w.unmount();
		wrapper = null;
		expect(w.emitted('edit')!.at(-1)).toEqual([null]);
	});

	it('spells out a failed save with retry and discard, without hover', async () => {
		const w = mountCell({ value: 'Mein Text', status: 'failed' });
		const alert = w.get('[role="alert"]');
		expect(alert.text()).toBe('Not saved');
		// The entry control's description includes the failure.
		expect(entry(w).attributes('aria-describedby')).toContain(alert.attributes('id'));

		await w.get('button[aria-label="Save Subject line (Deutsch) again"]').trigger('click');
		await w
			.get('button[aria-label="Discard your edit of Subject line (Deutsch)"]')
			.trigger('click');
		expect(w.emitted('retry')).toHaveLength(1);
		expect(w.emitted('discard')).toHaveLength(1);
	});

	it('tells a conflict apart from a plain failure', () => {
		const w = mountCell({ value: 'Mein Text', status: 'conflict' });
		expect(w.get('[role="alert"]').text()).toBe('Changed elsewhere since you edited it');
	});

	it('announces a pending save', () => {
		const w = mountCell({ value: 'Mein Text', status: 'saving' });
		expect(w.get('[role="status"]').text()).toBe('Saving…');
		expect(w.find('[data-testid="spinner"]').exists()).toBe(true);
	});

	it.each([
		['idle', {}],
		['failed', { status: 'failed' }],
		['editing', {}],
	] as const)('has no axe violations (%s)', async (state, extra) => {
		const violations = await auditA11y(TranslationCell, {
			props: { value: 'Hallo', fieldLabel: 'Subject line', languageLabel: 'Deutsch', ...extra },
			global: { plugins: [createTestI18n()], stubs },
			prepare: async (w) => {
				if (state === 'editing') await w.get('button').trigger('click');
			},
		});
		expect(violations).toEqual([]);
	});
});

/**
 * Issue #1080: the "source" badge and the "HTML" hover badge were absolutely
 * positioned in the cell's top-right corner with no room kept for them, so any
 * line long enough ran under the badge. happy-dom does no layout, so this pins
 * the structure that rules the overlap out: the badge is a non-shrinking item
 * in the same flex row as the text, and the text takes only the space left.
 */
describe('TranslationCell badges', () => {
	const LONG = 'A subject line long enough to reach the right edge of the cell and keep going';

	function badgeBesideText(w: VueWrapper, label: string) {
		const badge = w.findAll('span').find((s) => s.text() === label);
		expect(badge, `${label} badge`).toBeDefined();
		const text = w.findAll('span').find((s) => s.text() === LONG);
		expect(text, 'cell text').toBeDefined();

		expect(badge!.classes()).not.toContain('absolute');
		expect(badge!.classes()).toContain('shrink-0');
		expect(badge!.element.parentElement).toBe(text!.element.parentElement);
		expect(badge!.element.parentElement!.classList.contains('flex')).toBe(true);
		expect(text!.classes()).toEqual(expect.arrayContaining(['flex-1', 'min-w-0']));
	}

	it('keeps the source badge beside the source text, not over it', () => {
		const w = mountCell({ value: LONG, isDefault: true });
		badgeBesideText(w, 'source');
	});

	it('keeps the HTML badge beside the text of an editable cell, not over it', () => {
		const w = mountCell({ value: `<p>${LONG}</p>`, isHtml: true });
		badgeBesideText(w, 'HTML');
	});
});
