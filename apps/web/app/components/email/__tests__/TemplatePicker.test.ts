// @vitest-environment happy-dom
/**
 * The shared template picker (#1047).
 *
 * Both template pickers used to load the first 100 templates and stop: the
 * campaign search filtered that slice, the automation step was a native select
 * over it, so template 101 and beyond could not be found or chosen. The picker
 * now sends the query to the server and pages with `loadMore`, and tells
 * "still searching" apart from "nothing matches" and from a failed read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import TemplatePicker from '../TemplatePicker.vue';
import TemplateStatusBadge from '~/components/send/TemplateStatusBadge.vue';
import { useDebouncedSearch } from '~/composables/useDebouncedSearch';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { createTemplateServer, makeTemplates, type Template } from './templateServer';

const PAGE_SIZE = 25;
const TEMPLATES = makeTemplates(150);

let server: ReturnType<typeof createTemplateServer>;

beforeEach(() => {
	vi.useFakeTimers();
	server = createTemplateServer(TEMPLATES);
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useDebouncedSearch', useDebouncedSearch);
	vi.stubGlobal('useOrganizationPaginatedQuery', server.useOrganizationPaginatedQuery);
});

afterEach(() => {
	vi.useRealTimers();
});

function mountPicker(modelValue: string | null = null) {
	return mount(TemplatePicker, {
		props: { modelValue: modelValue as never, inputId: 'picker' },
		global: {
			plugins: [createTestI18n()],
			components: { SendTemplateStatusBadge: TemplateStatusBadge },
		},
		attachTo: document.body,
	});
}

/** Past the debounce, the server's answer and the loader's minimum on-screen time. */
async function settle() {
	for (let i = 0; i < 4; i++) {
		await vi.advanceTimersByTimeAsync(300);
		await flushPromises();
	}
}

const optionNames = (wrapper: ReturnType<typeof mountPicker>) =>
	wrapper.findAll('[role="option"]').map((o) => o.find('p').text());

describe('TemplatePicker: finding templates beyond the first page', () => {
	it('loads one page, then the next when the list is scrolled to its end', async () => {
		const wrapper = mountPicker();
		await settle();
		expect(wrapper.findAll('[role="option"]')).toHaveLength(PAGE_SIZE);

		const list = wrapper.get('[role="listbox"]').element as HTMLElement;
		Object.defineProperty(list, 'scrollHeight', { value: 2000, configurable: true });
		Object.defineProperty(list, 'clientHeight', { value: 300, configurable: true });
		list.scrollTop = 1700;
		await wrapper.get('[role="listbox"]').trigger('scroll');
		await settle();

		expect(server.state.loadMoreCalls).toBe(1);
		expect(wrapper.findAll('[role="option"]')).toHaveLength(PAGE_SIZE * 2);
		wrapper.unmount();
	});

	it('offers an explicit Load more while more pages exist', async () => {
		const wrapper = mountPicker();
		await settle();
		await wrapper.get('[data-testid="template-picker-load-more"]').trigger('click');
		await settle();
		expect(wrapper.findAll('[role="option"]')).toHaveLength(PAGE_SIZE * 2);
		wrapper.unmount();
	});

	it('sends the query to the server, so a template past the first page is found', async () => {
		const wrapper = mountPicker();
		await settle();
		expect(optionNames(wrapper)).not.toContain('Template 140');

		await wrapper.get('input').setValue('Template 140');
		await settle();

		expect(server.state.listCalls.at(-1)).toEqual({ type: 'marketing', search: 'Template 140' });
		expect(optionNames(wrapper)).toEqual(['Template 140']);
		wrapper.unmount();
	});

	it('emits the chosen template on click', async () => {
		const wrapper = mountPicker();
		await settle();
		await wrapper.get('input').setValue('Template 140');
		await settle();
		await wrapper.get('[role="option"]').trigger('click');

		expect(wrapper.emitted('update:modelValue')).toEqual([['tpl_140']]);
		expect((wrapper.emitted('select')![0]![0] as Template).name).toBe('Template 140');
		wrapper.unmount();
	});

	it('shows name, subject and a Draft/Published badge on every row', async () => {
		const wrapper = mountPicker();
		await settle();
		const [first, second] = wrapper.findAll('[role="option"]');
		expect(first!.text()).toContain('Template 1');
		expect(first!.text()).toContain('Subject line 1');
		expect(first!.text()).toContain('Draft');
		expect(second!.text()).toContain('Published');
		wrapper.unmount();
	});
});

describe('TemplatePicker: keyboard and screen readers', () => {
	it('is a combobox over a labelled listbox, marking the selected option', async () => {
		const wrapper = mountPicker('tpl_2');
		await settle();
		const input = wrapper.get('input');
		const list = wrapper.get('[role="listbox"]');
		expect(input.attributes('role')).toBe('combobox');
		expect(input.attributes('aria-controls')).toBe(list.attributes('id'));
		expect(list.attributes('aria-label')).toBe('Templates');
		const selected = wrapper.findAll('[role="option"][aria-selected="true"]');
		expect(selected.map((o) => o.attributes('id'))).toEqual([`${list.attributes('id')}-tpl_2`]);
		wrapper.unmount();
	});

	it('moves the active option with the arrow keys and picks it with Enter', async () => {
		const wrapper = mountPicker();
		await settle();
		const input = wrapper.get('input');
		await input.trigger('keydown', { key: 'ArrowDown' });
		await input.trigger('keydown', { key: 'ArrowDown' });
		const listId = wrapper.get('[role="listbox"]').attributes('id');
		expect(input.attributes('aria-activedescendant')).toBe(`${listId}-tpl_2`);

		await input.trigger('keydown', { key: 'Enter' });
		expect(wrapper.emitted('update:modelValue')).toEqual([['tpl_2']]);
		wrapper.unmount();
	});

	it('pages in more rows when the keyboard reaches the last loaded one', async () => {
		const wrapper = mountPicker();
		await settle();
		await wrapper.get('input').trigger('keydown', { key: 'End' });
		await settle();
		expect(server.state.loadMoreCalls).toBe(1);
		wrapper.unmount();
	});

	it('clears the query with Escape', async () => {
		const wrapper = mountPicker();
		await settle();
		const input = wrapper.get('input');
		await input.setValue('Template 140');
		await input.trigger('keydown', { key: 'Escape' });
		expect((input.element as HTMLInputElement).value).toBe('');
		wrapper.unmount();
	});
});

describe('TemplatePicker: searching, no match, failure', () => {
	it('says Searching while the query is in flight, and No templates match only once it resolves', async () => {
		const wrapper = mountPicker();
		await settle();

		server.state.hold = true;
		await wrapper.get('input').setValue('nothing like this');
		// Still inside the debounce: the old rows must not stand in for an answer.
		await vi.advanceTimersByTimeAsync(200);
		expect(wrapper.find('[role="option"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="template-picker-empty"]').exists()).toBe(false);

		await settle();
		expect(server.state.listCalls.at(-1)?.search).toBe('nothing like this');
		expect(wrapper.get('[data-testid="template-picker-pending"]').text()).toBe('Searching…');
		expect(wrapper.find('[data-testid="template-picker-empty"]').exists()).toBe(false);

		server.flush();
		await settle();
		expect(wrapper.find('[data-testid="template-picker-pending"]').exists()).toBe(false);
		expect(wrapper.get('[data-testid="template-picker-empty"]').text()).toBe(
			'No templates match your search.'
		);
		wrapper.unmount();
	});

	it('says there are no templates yet, not "no match", when the organization has none', async () => {
		server = createTemplateServer([]);
		vi.stubGlobal('useOrganizationPaginatedQuery', server.useOrganizationPaginatedQuery);
		const wrapper = mountPicker();
		await settle();
		expect(wrapper.get('[data-testid="template-picker-empty"]').text()).toBe('No templates yet.');
		wrapper.unmount();
	});

	it('shows the failed-read state with a Try again that re-reads', async () => {
		server.state.fail = true;
		const wrapper = mountPicker();
		await settle();

		expect(wrapper.text()).toContain('Failed to load');
		expect(wrapper.find('[data-testid="template-picker-empty"]').exists()).toBe(false);
		const retry = wrapper.findAll('button').find((b) => b.text() === 'Try again');
		await retry!.trigger('click');
		expect(server.state.refetch).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});
});
