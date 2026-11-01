/**
 * The flow's Undo and Exit say what they do, with their keys, in a UiTooltip
 * that keyboard focus opens too; a native title showed neither on focus.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';

import AgentTaskFlow from '../AgentTaskFlow.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { focusTooltip, tooltipOf } from '~/__tests__/tooltip';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

function mountFlow(props: Record<string, unknown> = {}) {
	return mount(AgentTaskFlow, {
		props: { position: 2, total: 5, canUndo: true, ...props },
		slots: { default: '<div>card</div>' },
		attachTo: document.body,
		global: { plugins: [createTestI18n()] },
	});
}

const byText = (w: ReturnType<typeof mountFlow>, text: string) =>
	w.findAll('button').find((button) => button.text() === text)!;

describe('AgentTaskFlow tooltips', () => {
	it('puts Undo and Exit in tooltips with their keys, and no native title on any control', async () => {
		const w = mountFlow();
		const undo = byText(w, 'Undo');
		const exit = byText(w, 'Exit');

		expect(tooltipOf(w, undo)).toBe('Undo last');
		expect(tooltipOf(w, exit)).toBe('Exit');
		expect(await focusTooltip(undo)).toBe('Undo last Ctrl+Z');
		expect(await focusTooltip(exit)).toBe('Exit Esc');
		expect(w.findAll('[title]')).toHaveLength(0);
		w.unmount();
	});

	it('links the tooltip as the description while it shows a key the name lacks', () => {
		const w = mountFlow();
		const exit = byText(w, 'Exit').element as HTMLElement;
		exit.focus();
		const bubble = document.querySelector('[role="tooltip"]');
		expect(exit.getAttribute('aria-describedby')).toBe(bubble!.id);
		exit.blur();
		expect(exit.hasAttribute('aria-describedby')).toBe(false);
		w.unmount();
	});

	it('offers no Undo, and so no tooltip for it, when there is nothing to undo', () => {
		const w = mountFlow({ canUndo: false });
		expect(w.findAll('button').some((button) => button.text() === 'Undo')).toBe(false);
		w.unmount();
	});
});
