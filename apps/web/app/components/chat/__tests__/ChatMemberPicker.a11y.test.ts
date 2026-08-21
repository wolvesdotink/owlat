// @vitest-environment happy-dom
/**
 * Regression guard for the mislabeled-icon-button fix: a blind auto-fixer had
 * stamped generic aria-label="Close" on the per-member remove buttons, which
 * misled screen-reader users. Each remove control must instead announce the
 * action and its target ("Remove {label}"), never "Close"/"Confirm".
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';

import ChatMemberPicker from '../ChatMemberPicker.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const iconStub = { props: ['name'], template: '<span />' };

function mountPicker() {
	return mount(ChatMemberPicker, {
		props: {
			modelValue: [
				{ memberId: 'm1', label: 'Ada Lovelace' },
				{ memberId: 'm2', label: 'grace@example.com' },
			],
			query: '',
		},
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: iconStub },
		},
	});
}

describe('ChatMemberPicker accessibility', () => {
	it('names each remove button by its member, not "Close"/"Confirm"', () => {
		const wrapper = mountPicker();
		const labels = wrapper.findAll('button').map((b) => b.attributes('aria-label'));

		expect(labels).toContain('Remove Ada Lovelace');
		expect(labels).toContain('Remove grace@example.com');
		for (const label of labels) {
			expect(label).not.toBe('Close');
			expect(label).not.toBe('Confirm');
		}
		expectFullyLocalized(wrapper);
	});
});
