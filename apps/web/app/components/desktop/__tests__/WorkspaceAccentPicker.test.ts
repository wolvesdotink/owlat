// @vitest-environment happy-dom
/**
 * The workspace accent swatches (plan item OW-010): with a mouse each button
 * is the 20px dot it always was; on a coarse pointer the button grows to the
 * 44px target the `.btn` recipe uses while the drawn dot stays 20px, and the
 * row wraps rather than shrink a target. happy-dom has no layout, so this pins
 * the class contract; the rendered geometry is checked in a real browser.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import WorkspaceAccentPicker from '../WorkspaceAccentPicker.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { WORKSPACE_ACCENT_OPTIONS } from '~/lib/desktop/workspaceTypes';
import de from '~~/i18n/locales/de.json';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const SWATCH = '[data-testid="workspace-swatch"]';

type Locale = 'en' | 'de';

/**
 * The shared helper's English catalog, plus the real German one for `de`. No
 * fallback: a German message that is missing must fail here, not quietly
 * render the English word.
 */
function i18nFor(locale: Locale) {
	const i18n = createTestI18n();
	if (locale === 'de') {
		i18n.global.setLocaleMessage('de', de);
		i18n.global.locale.value = 'de';
		i18n.global.fallbackLocale.value = false;
	}
	return i18n;
}

function render(modelValue = WORKSPACE_ACCENT_OPTIONS[2].value, locale: Locale = 'en') {
	return mount(WorkspaceAccentPicker, {
		props: { modelValue, options: WORKSPACE_ACCENT_OPTIONS },
		global: { plugins: [i18nFor(locale)] },
	});
}

/** The accent names, in palette order, as each catalog spells them. */
const ACCENT_NAMES: Record<Locale, string[]> = {
	en: ['Moss', 'Terracotta', 'Slate', 'Plum', 'Gold', 'Graphite'],
	de: ['Moos', 'Terrakotta', 'Schiefer', 'Pflaume', 'Gold', 'Graphit'],
};

describe('WorkspaceAccentPicker', () => {
	it('renders one pressed-state button per curated accent', () => {
		const swatches = render().findAll(SWATCH);
		expect(swatches).toHaveLength(WORKSPACE_ACCENT_OPTIONS.length);
		expect(swatches.map((s) => s.attributes('aria-pressed'))).toEqual(
			WORKSPACE_ACCENT_OPTIONS.map((_, i) => String(i === 2))
		);
		expect(swatches[0]!.attributes('aria-label')).toBe('Moss accent');
	});

	it('carries a catalog key for every accent name, present in every locale', () => {
		const i18n = i18nFor('en');
		for (const option of WORKSPACE_ACCENT_OPTIONS) {
			expect(option.label).toMatch(/^desktop\.settings\.workspaces\.accents\.[a-z]+$/);
			expect(i18n.global.te(option.label, 'en')).toBe(true);
		}
		const german = i18nFor('de');
		for (const option of WORKSPACE_ACCENT_OPTIONS) {
			expect(german.global.te(option.label, 'de')).toBe(true);
		}
	});

	it.each(['en', 'de'] as const)('names every swatch in the %s copy', (locale) => {
		const swatches = render(WORKSPACE_ACCENT_OPTIONS[0].value, locale).findAll(SWATCH);
		expect(swatches.map((s) => s.attributes('title'))).toEqual(ACCENT_NAMES[locale]);
		expect(swatches.map((s) => s.attributes('aria-label'))).toEqual(
			ACCENT_NAMES[locale].map((name) => (locale === 'de' ? `Akzent ${name}` : `${name} accent`))
		);
	});

	it('emits the chosen accent', async () => {
		const wrapper = render();
		await wrapper.findAll(SWATCH)[4]!.trigger('click');
		expect(wrapper.emitted('update:modelValue')).toEqual([[WORKSPACE_ACCENT_OPTIONS[4].value]]);
	});

	it('is a 20px button with a mouse and a 44px one on touch', () => {
		for (const swatch of render().findAll(SWATCH)) {
			const classes = swatch.classes();
			expect(classes).toContain('size-5');
			expect(classes).toContain('pointer-coarse:size-11');
			// The target is the button's own box in the row flow, not an overlay.
			expect(classes.join(' ')).not.toMatch(/before:|after:|absolute|-m[xy]?-/);
		}
	});

	it('keeps the drawn dot at 20px on every pointer', () => {
		const wrapper = render();
		const dots = wrapper.findAll(`${SWATCH} > span`);
		expect(dots).toHaveLength(WORKSPACE_ACCENT_OPTIONS.length);
		for (const [i, dot] of dots.entries()) {
			expect(dot.classes()).toContain('size-5');
			expect(dot.classes().some((c) => c.startsWith('pointer-coarse:'))).toBe(false);
			expect(dot.attributes('style')).toContain('background-color');
			expect(dot.classes()).toContain(i === 2 ? 'border-text-primary' : 'border-transparent');
		}
	});

	it('keeps the touch targets apart and wraps them instead of shrinking one', () => {
		const classes = render().classes();
		expect(classes).toContain('gap-1.5');
		expect(classes).toContain('pointer-coarse:gap-0.5');
		expect(classes).toContain('pointer-coarse:flex-wrap');
	});
});
