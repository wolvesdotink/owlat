/**
 * The reader's company and tasks rail: it hands the open thread to the panel,
 * and its collapse is one remembered choice that hides the panel and says so
 * to assistive tech.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import PostboxContextRail from '../PostboxContextRail.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

vi.mock('~/components/companies/CompanyContextPanel.vue', () => ({
	default: defineComponent({
		name: 'CompanyContextPanel',
		props: { mailThreadId: { type: String, default: undefined } },
		setup: (props) => () => h('div', { 'data-testid': 'panel' }, props.mailThreadId),
	}),
}));

const store = new Map<string, unknown>();

beforeEach(() => {
	store.clear();
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useLocalStorage', (key: string, def: unknown) => {
		const data = ref(store.has(key) ? store.get(key) : def);
		return {
			data,
			set: (value: unknown) => {
				data.value = value;
				store.set(key, value);
			},
		};
	});
});

/** The region the toggle controls is hidden (v-show), not unmounted. */
function bodyHidden(w: ReturnType<typeof mountRail>): boolean {
	const id = w.get('[data-testid="postbox-context-rail-toggle"]').attributes('aria-controls');
	return (w.get(`[id="${id}"]`).element as HTMLElement).style.display === 'none';
}

function mountRail() {
	return mount(PostboxContextRail, {
		props: { threadId: 'mt1' },
		global: { plugins: [createTestI18n()] },
	});
}

describe('PostboxContextRail', () => {
	it('shows the panel for the open thread, expanded by default', () => {
		const w = mountRail();
		expect(w.get('[data-testid="panel"]').text()).toBe('mt1');
		const toggle = w.get('[data-testid="postbox-context-rail-toggle"]');
		expect(toggle.attributes('aria-expanded')).toBe('true');
		expect(toggle.attributes('aria-label')).toBe('Hide company and tasks');
		expect(w.text()).toContain('Company & tasks');
		expectFullyLocalized(w);
	});

	it('collapses, remembers it, and opens again', async () => {
		const w = mountRail();
		const toggle = w.get('[data-testid="postbox-context-rail-toggle"]');
		await toggle.trigger('click');
		expect(store.get('postbox-context-rail-collapsed')).toBe(true);
		expect(toggle.attributes('aria-expanded')).toBe('false');
		expect(toggle.attributes('aria-label')).toBe('Show company and tasks');
		expect(bodyHidden(w)).toBe(true);

		const next = mountRail();
		expect(next.get('[data-testid="postbox-context-rail"]').attributes('data-collapsed')).toBe(
			'true'
		);
		await next.get('[data-testid="postbox-context-rail-toggle"]').trigger('click');
		expect(store.get('postbox-context-rail-collapsed')).toBe(false);
		expect(bodyHidden(next)).toBe(false);
	});
});
