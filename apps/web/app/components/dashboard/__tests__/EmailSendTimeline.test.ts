/**
 * The data variables card of a transactional send: the values only for a
 * viewer the backend gave them to, the names always, and what happened to the
 * values otherwise (hidden from this role, or removed after retention).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import EmailSendTimeline from '../EmailSendTimeline.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useCopyToClipboard: () => ({ copy: async () => undefined, copiedKey: ref(null) }),
	});
});

function mountTimeline(props: Record<string, unknown>) {
	return mount(EmailSendTimeline, {
		props: { status: 'delivered', sentAt: 1, deliveredAt: 2, ...props },
		global: { plugins: [createTestI18n()], stubs: { UiButton: true } },
	});
}

describe('EmailSendTimeline data variables', () => {
	it('shows the names and no values to a viewer the values are hidden from', () => {
		const w = mountTimeline({
			dataVariableNames: ['firstName', 'resetUrl'],
			dataVariablesAccess: 'hidden',
		});

		expect(w.findAll('li').map((li) => li.text())).toEqual(['firstName', 'resetUrl']);
		expect(w.find('[data-testid="data-variables-note"]').text()).toContain(
			'Only owners and admins'
		);
		expect(w.find('pre').exists()).toBe(false);
		w.unmount();
	});

	it('says the values were removed once retention ended', () => {
		const w = mountTimeline({ dataVariableNames: ['resetUrl'], dataVariablesAccess: 'redacted' });

		expect(w.findAll('li').map((li) => li.text())).toEqual(['resetUrl']);
		expect(w.find('[data-testid="data-variables-note"]').text()).toContain('removed');
		w.unmount();
	});

	it('shows the values to a viewer who may see them, with when they are removed', async () => {
		const w = mountTimeline({
			dataVariables: { resetUrl: 'https://example.com/reset?token=t' },
			dataVariableNames: ['resetUrl'],
			dataVariablesAccess: 'visible',
			dataVariablesRemovedAfter: Date.UTC(2026, 10, 2, 9, 0, 0),
		});

		expect(w.find('[data-testid="data-variables-note"]').text()).toContain('removed after');
		await w.find('button[aria-expanded]').trigger('click');
		expect(w.find('pre').text()).toContain('token=t');
		w.unmount();
	});
});
