/**
 * The feature picker shared by Settings → Features and the setup wizard.
 *
 * Pinned here: packs are the visible controls and the individual flags wait
 * behind a per-pack Customize disclosure; flag keys, env names and Docker
 * profiles only appear inside a flag's collapsed "Technical details"; and a
 * blocked flag names its missing parent by label, not by key; and a partial
 * pack reads as a mixed checkbox.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { FEATURE_FLAGS, resolveFlags, type FeatureFlagState } from '@owlat/shared/featureFlags';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import FeaturePackList from '../FeaturePackList.vue';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const cardStub = { template: '<section><slot /></section>' };

function mountList(stored: FeatureFlagState = {}, extra: Record<string, unknown> = {}) {
	return mount(FeaturePackList, {
		props: {
			registry: FEATURE_FLAGS,
			stored,
			resolved: resolveFlags(stored),
			...extra,
		},
		global: { plugins: [createTestI18n()], stubs: { UiCard: cardStub, Icon: true } },
	});
}

function panelFor(wrapper: ReturnType<typeof mountList>, group: string) {
	const button = wrapper.get(`[data-testid="feature-customize-${group}"]`);
	const panel = wrapper.get(`#${button.attributes('aria-controls')}`);
	return { button, panel };
}

describe('FeaturePackList', () => {
	it('shows the packs and keeps each pack\'s flags collapsed behind "Customize"', async () => {
		const wrapper = mountList();
		for (const label of ['Email client', 'Marketing', 'AI', 'More features']) {
			expect(wrapper.text()).toContain(label);
		}

		const { button, panel } = panelFor(wrapper, 'ai');
		expect(button.attributes('aria-expanded')).toBe('false');
		expect(panel.attributes('style')).toContain('display: none');

		await button.trigger('click');
		expect(button.attributes('aria-expanded')).toBe('true');
		expect(panel.attributes('style') ?? '').not.toContain('display: none');
		expect(panel.text()).toContain('Use related facts in drafts');
	});

	it("counts how many of a group's features are on", () => {
		const wrapper = mountList({ inbox: true });
		expect(wrapper.get('[data-testid="feature-customize-emailClient"]').text()).toMatch(
			/Customize \(1 of \d+ on\)/
		);
	});

	it('keeps flag keys, env names and Docker profiles inside "Technical details"', () => {
		const wrapper = mountList();
		const row = wrapper.get('[data-testid="feature-switch-mail.external"]').element.closest('li')!;
		const details = row.querySelector('[data-testid="feature-flag-technical-details"]')!;
		expect(details.tagName).toBe('DETAILS');
		expect(details.hasAttribute('open')).toBe(false);
		expect(details.textContent).toContain('mail.external');
		expect(details.textContent).toContain('MAIL_SYNC_API_URL');
		expect(details.textContent).toContain('external-mail');

		// Outside the details, the row reads as label + description only.
		const visibleText = (row.textContent ?? '').replace(details.textContent ?? '', '');
		expect(visibleText).not.toContain('MAIL_SYNC_API_URL');
		expect(visibleText).not.toContain('mail.external');
	});

	it('names a missing parent by its label and disables the switch', () => {
		const wrapper = mountList({});
		const graph = wrapper.get('[data-testid="feature-switch-ai.knowledge.graphRetrieval"]');
		expect(graph.attributes('disabled')).toBeDefined();
		expect(graph.attributes('title')).toBe('Turn on Knowledge graph first');
	});

	it('emits pack and flag toggles for the parent to persist', async () => {
		const wrapper = mountList({ ai: true, inbox: true });
		await wrapper.get('button[aria-label="Toggle AI"]').trigger('click');
		expect(wrapper.emitted('toggle-pack')).toEqual([['ai']]);

		await wrapper.get('[data-testid="feature-switch-ai.agent"]').trigger('click');
		expect(wrapper.emitted('toggle-flag')).toEqual([['ai.agent', true]]);
	});

	it('reports a pack as a checkbox that is unchecked, mixed or checked', () => {
		const marketing = (stored: FeatureFlagState) =>
			mountList(stored).get('button[aria-label="Toggle Marketing"]');
		const none = { campaigns: false, automations: false, transactional: false };
		const some = { campaigns: true, automations: false, transactional: false };
		const all = { campaigns: true, automations: true, transactional: true };

		expect(marketing(none).attributes('role')).toBe('checkbox');
		expect(marketing(none).attributes('aria-checked')).toBe('false');
		expect(marketing(some).attributes('aria-checked')).toBe('mixed');
		expect(marketing(all).attributes('aria-checked')).toBe('true');
	});

	it('reports a single flag as checked or unchecked, never mixed', () => {
		const wrapper = mountList({ inbox: true, chat: false });
		expect(wrapper.get('[data-testid="feature-switch-inbox"]').attributes('aria-checked')).toBe(
			'true'
		);
		expect(wrapper.get('[data-testid="feature-switch-chat"]').attributes('aria-checked')).toBe(
			'false'
		);
	});

	it('flags a group that holds a feature needing setup', () => {
		const wrapper = mountList(
			{ 'mail.external': true },
			{
				needsConfig: new Set(['mail.external']),
				missingConfig: { 'mail.external': ['MAIL_SYNC_API_URL'] },
			}
		);
		expect(wrapper.get('[data-testid="feature-group-emailClient"]').text()).toContain(
			'Needs setup'
		);
		expect(wrapper.get('[data-testid="feature-group-marketing"]').text()).not.toContain(
			'Needs setup'
		);
	});
});
