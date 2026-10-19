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

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const SWATCH = '[data-testid="workspace-accent-swatch"]';

function render(modelValue = WORKSPACE_ACCENT_OPTIONS[2].value) {
	return mount(WorkspaceAccentPicker, {
		props: { modelValue },
		global: { plugins: [createTestI18n()] },
	});
}

describe('WorkspaceAccentPicker', () => {
	it('renders one pressed-state button per curated accent', () => {
		const swatches = render().findAll(SWATCH);
		expect(swatches).toHaveLength(WORKSPACE_ACCENT_OPTIONS.length);
		expect(swatches.map((s) => s.attributes('aria-pressed'))).toEqual(
			WORKSPACE_ACCENT_OPTIONS.map((_, i) => String(i === 2))
		);
		expect(swatches[0]!.attributes('aria-label')).toBe('Moss accent');
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
