// @vitest-environment happy-dom
/**
 * "Create and design email" (#1048): a new template has no body, so the step
 * creates and attaches it and then hands it to the editor (`compose`) instead
 * of advancing to a Review that could only report an empty email. Picking an
 * existing template still just advances (`submit`).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';

import ContentStep from '../ContentStep.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { installNuxtStubs, paginatedResult, queryResult } from '~/__tests__/a11y';
import { useModal } from '~/composables/useModal';

const runs: { label: string; args: Record<string, unknown> }[] = [];

beforeEach(() => {
	runs.length = 0;
	installNuxtStubs({
		...i18nStubs,
		useModal,
		useConvexQuery: () => queryResult({ _id: 'cmp1', name: 'Weekly digest', subject: 'This week' }),
		useOrganizationPaginatedQuery: () =>
			paginatedResult([{ _id: 'tpl_old', name: 'Old digest', subject: 'Last week' }]),
		useBackendOperation: (_ref: unknown, options: { label: () => string }) => ({
			run: async (args: Record<string, unknown>) => {
				const label = options.label();
				runs.push({ label, args });
				return { ok: true, result: label === 'Create email template' ? 'tpl_new' : null };
			},
			isLoading: ref(false),
		}),
	});
});

function mountStep() {
	return mount(ContentStep, {
		props: { campaignId: 'cmp1' as never },
		global: { plugins: [createTestI18n()], stubs: { Icon: true } },
	});
}

describe('ContentStep new email', () => {
	it('labels the option "Create and design email"', () => {
		expect(mountStep().text()).toContain('Create and design email');
	});

	it('creates and attaches the email, then opens it in the editor', async () => {
		const wrapper = mountStep();
		await wrapper.find('input[value="new"]').setValue();
		expect(wrapper.find('button[type="submit"]').text()).toBe('Create and open editor');

		await wrapper.find('form').trigger('submit');
		await flushPromises();

		expect(runs.map((run) => run.label)).toEqual([
			'Create email template',
			'Update campaign content',
		]);
		expect(runs[1]!.args).toMatchObject({ campaignId: 'cmp1', emailTemplateId: 'tpl_new' });
		expect(wrapper.emitted('compose')).toEqual([['tpl_new']]);
		expect(wrapper.emitted('submit')).toBeUndefined();
	});

	it('still just advances with an existing email', async () => {
		const wrapper = mountStep();
		await wrapper
			.findAll('button[type="button"]')
			.find((button) => button.text().includes('Old digest'))!
			.trigger('click');

		await wrapper.find('form').trigger('submit');
		await flushPromises();

		expect(wrapper.emitted('submit')).toHaveLength(1);
		expect(wrapper.emitted('compose')).toBeUndefined();
	});
});
