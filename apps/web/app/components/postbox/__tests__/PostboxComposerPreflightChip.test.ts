// @vitest-environment happy-dom
/**
 * The footer's pre-send chip (plan idea 6): the findings arrive as catalog keys
 * with params, and this is the render boundary that resolves them. It also has
 * to disappear entirely when there is nothing to say — an always-visible "0
 * checks" is noise, and noise is what gets warnings ignored.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

import PostboxComposerPreflightChip from '../PostboxComposerPreflightChip.vue';
import type { PreflightFinding } from '~/utils/postboxPreflight';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

function mountChip(findings: PreflightFinding[]) {
	return mount(PostboxComposerPreflightChip, {
		props: { findings },
		global: { plugins: [createTestI18n()], stubs: { Icon: true } },
	});
}

describe('PostboxComposerPreflightChip', () => {
	it('renders nothing when the draft is clean', () => {
		expect(mountChip([]).find('[data-testid="postbox-preflight-chip"]').exists()).toBe(false);
	});

	it('resolves one finding, in the singular', () => {
		const wrapper = mountChip([
			{ id: 'emptySubject', key: 'shared.postbox.preflight.emptySubject' },
		]);
		expect(wrapper.text()).toBe('1 check: no subject');
	});

	it('resolves several findings with their params, in the plural', () => {
		const wrapper = mountChip([
			{ id: 'emptySubject', key: 'shared.postbox.preflight.emptySubject' },
			{
				id: 'placeholder',
				key: 'shared.postbox.preflight.placeholder',
				params: { token: '[TODO]' },
			},
		]);
		expect(wrapper.text()).toBe('2 checks: no subject · “[TODO]” left in the message');
	});
});
