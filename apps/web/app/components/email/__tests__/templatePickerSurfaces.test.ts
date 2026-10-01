// @vitest-environment happy-dom
/**
 * Both template pickers, mounted with the shared picker inside (#1047).
 *
 * The organization holds 150 templates, more than one page. On each surface a
 * template past the first page must be found by search and selectable, and a
 * selection that is not among the rows on screen must still render: it is read
 * by id, not looked up in the list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import ContentStep from '~/components/campaigns/steps/ContentStep.vue';
import EmailStepEditor from '~/components/automations/steps/email/Editor.vue';
import TemplatePicker from '../TemplatePicker.vue';
import TemplateStatusBadge from '~/components/send/TemplateStatusBadge.vue';
import { useDebouncedSearch } from '~/composables/useDebouncedSearch';
import { useEmailTemplateById } from '~/composables/useEmailTemplateById';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { queryResult } from '~/__tests__/queryStubs';
import { createTemplateServer, makeTemplates } from './templateServer';

const TEMPLATES = makeTemplates(150);

let server: ReturnType<typeof createTemplateServer>;

beforeEach(() => {
	vi.useFakeTimers();
	server = createTemplateServer(TEMPLATES);
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useDebouncedSearch', useDebouncedSearch);
	vi.stubGlobal('useEmailTemplateById', useEmailTemplateById);
	vi.stubGlobal('useOrganizationPaginatedQuery', server.useOrganizationPaginatedQuery);
	vi.stubGlobal('useOrganizationQuery', server.useOrganizationQuery);
});

afterEach(() => {
	vi.useRealTimers();
});

const global = {
	plugins: [createTestI18n()],
	components: { EmailTemplatePicker: TemplatePicker, SendTemplateStatusBadge: TemplateStatusBadge },
};

async function settle() {
	for (let i = 0; i < 4; i++) {
		await vi.advanceTimersByTimeAsync(300);
		await flushPromises();
	}
}

const optionNames = (wrapper: {
	findAll: (s: string) => Array<{ find: (s: string) => { text: () => string } }>;
}) => wrapper.findAll('[role="option"]').map((o) => o.find('p').text());

describe('campaign Content', () => {
	function mountContentStep(campaign: Record<string, unknown>) {
		vi.stubGlobal('useConvexQuery', () => ({ ...queryResult(null), data: ref(campaign) }));
		vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(), isLoading: ref(false) }));
		vi.stubGlobal('useModal', () => ({ isLoading: ref(false), setLoading: vi.fn() }));
		return mount(ContentStep, {
			props: { campaignId: 'cmp_1' as never },
			global,
			attachTo: document.body,
		});
	}

	it('finds a template past the first page by search and selects it', async () => {
		const wrapper = mountContentStep({ _id: 'cmp_1', name: 'Launch', subject: '' });
		await settle();
		expect(optionNames(wrapper)).not.toContain('Template 140');

		await wrapper.get('#templateSearch').setValue('Template 140');
		await settle();
		expect(server.state.listCalls.at(-1)).toEqual({ type: 'marketing', search: 'Template 140' });
		await wrapper.get('[role="option"]').trigger('click');

		const exposed = wrapper.vm as unknown as {
			selectedTemplate: { name: string } | null;
			campaignSubject: string;
		};
		expect(exposed.selectedTemplate?.name).toBe('Template 140');
		// An empty campaign subject is filled from the chosen template.
		expect(exposed.campaignSubject).toBe('Subject line 140');
		expect(wrapper.text()).toContain('Selected template');
		wrapper.unmount();
	});

	it('still shows a selected template that is outside the current results', async () => {
		// The campaign's relation carries no template row: only the by-id read can
		// name it, and it is neither on the first page nor in the search below.
		const wrapper = mountContentStep({
			_id: 'cmp_1',
			name: 'Launch',
			subject: 'Hello',
			emailTemplateId: 'tpl_149',
			emailTemplate: null,
		});
		await settle();
		await wrapper.get('#templateSearch').setValue('Template 3');
		await settle();

		expect(optionNames(wrapper)).not.toContain('Template 149');
		expect(wrapper.text()).toContain('Selected template');
		expect(wrapper.text()).toContain('Template 149');
		wrapper.unmount();
	});
});

describe('automation email step', () => {
	function mountEditor(emailTemplateId: string) {
		return mount(EmailStepEditor, {
			props: { modelValue: { emailTemplateId, subjectOverride: undefined } },
			global,
			attachTo: document.body,
		});
	}

	it('finds a template past the first page by search and selects it', async () => {
		const wrapper = mountEditor('');
		await settle();
		expect(optionNames(wrapper)).not.toContain('Template 140');

		await wrapper.get('#emailStepTemplate').setValue('Template 140');
		await settle();
		expect(server.state.listCalls.at(-1)).toEqual({ type: 'marketing', search: 'Template 140' });
		await wrapper.get('[role="option"]').trigger('click');

		expect(wrapper.emitted('update:modelValue')).toEqual([
			[{ emailTemplateId: 'tpl_140', subjectOverride: undefined }],
		]);
		expect(wrapper.emitted('save')).toHaveLength(1);
		wrapper.unmount();
	});

	it('previews a selected template that is not on the loaded page', async () => {
		const wrapper = mountEditor('tpl_149');
		await settle();

		expect(optionNames(wrapper)).not.toContain('Template 149');
		const preview = wrapper.text();
		expect(preview).toContain('Template preview');
		expect(preview).toContain('Template 149');
		expect(preview).toContain('Subject: Subject line 149');
		wrapper.unmount();
	});

	it('points to template creation when the organization has none', async () => {
		server = createTemplateServer([]);
		vi.stubGlobal('useOrganizationPaginatedQuery', server.useOrganizationPaginatedQuery);
		vi.stubGlobal('useOrganizationQuery', server.useOrganizationQuery);
		const wrapper = mountEditor('');
		await settle();

		expect(wrapper.get('[data-testid="template-picker-empty"]').text()).toBe(
			'No marketing templates yet. Create an email template first.'
		);
		wrapper.unmount();
	});
});
