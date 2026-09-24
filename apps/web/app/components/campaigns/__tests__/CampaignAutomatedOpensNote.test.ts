// @vitest-environment happy-dom
/**
 * The line under an open count that says what it leaves out (#764): the
 * automated opens counted apart, or a caveat for opens counted before the
 * split existed.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';

import CampaignAutomatedOpensNote from '../CampaignAutomatedOpensNote.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

Object.assign(globalThis, i18nStubs);

function render(props: { automatedOpens: number; isAutomatedOpenFiltered: boolean }) {
	return mount(CampaignAutomatedOpensNote, {
		props,
		global: { plugins: [createTestI18n()], stubs: { Icon: true } },
	});
}

describe('CampaignAutomatedOpensNote', () => {
	it('names how many emails were fetched automatically', () => {
		const wrapper = render({ automatedOpens: 1204, isAutomatedOpenFiltered: true });
		expect(wrapper.text()).toContain('1,204 emails were fetched automatically');
		expect(wrapper.text()).toContain('not counted as opens');
		expect(wrapper.text()).toContain('Apple Mail Privacy Protection');
	});

	it('uses the singular for one email', () => {
		const wrapper = render({ automatedOpens: 1, isAutomatedOpenFiltered: true });
		expect(wrapper.text()).toContain('1 email was fetched automatically by');
	});

	it('renders nothing when there is nothing to explain', () => {
		const wrapper = render({ automatedOpens: 0, isAutomatedOpenFiltered: true });
		expect(wrapper.text()).toBe('');
		expect(wrapper.find('p').exists()).toBe(false);
	});

	it('warns that opens counted before the filter may include automated ones', () => {
		const wrapper = render({ automatedOpens: 0, isAutomatedOpenFiltered: false });
		expect(wrapper.text()).toContain('counted before automated opens were filtered out');
	});

	it('shows both lines for a period that mixes filtered and older campaigns', () => {
		const wrapper = render({ automatedOpens: 30, isAutomatedOpenFiltered: false });
		expect(wrapper.findAll('p')).toHaveLength(2);
	});
});
