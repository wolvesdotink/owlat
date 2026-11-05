/**
 * "Make task": the popover starts with the given title as Only me, sends the
 * conversation and company it was opened for, emits the new id, and offers to
 * open the task from its toast. Only me keeps the assignee picker shut.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useTaskDraft } from '~/composables/useTaskDraft';
import TaskCreatePopover from '../TaskCreatePopover.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const create = vi.fn(async (_args: Record<string, unknown>) => ({ ok: true, result: 'task_1' }));
const showToast = vi.fn();
const navigateTo = vi.fn();

const members = [
	{ userId: 'me', name: 'Mia', email: 'mia@owlat.example', image: null },
	{ userId: 'bo', name: 'Bo', email: 'bo@owlat.example', image: null },
];
const groups = [{ _id: 'g1', name: 'Management', memberUserIds: ['me', 'bo'], isMember: true }];

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useBackendOperation', () => ({ run: create, isLoading: ref(false) }));
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('navigateTo', navigateTo);
	vi.stubGlobal('useTaskDraft', useTaskDraft);
	vi.stubGlobal('useTaskPeople', () => ({
		viewerId: ref('me'),
		members: computed(() => members),
		byId: computed(() => new Map(members.map((m) => [m.userId, m]))),
		groups: computed(() => groups),
		nameOf: (id: string) => members.find((m) => m.userId === id)?.name ?? 'Someone',
	}));
});

beforeEach(() => {
	create.mockClear();
	showToast.mockClear();
	navigateTo.mockClear();
});

const popoverStub = {
	props: ['open'],
	emits: ['update:open'],
	template:
		'<div><div class="trigger" @click="$emit(\'update:open\', !open)"><slot name="trigger" /></div><div v-if="open" class="panel"><slot /></div></div>',
};

function mountPopover(props: Record<string, unknown> = {}) {
	return mount(TaskCreatePopover, {
		props,
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			stubs: { UiPopover: popoverStub, UiAvatar: true, UiCombobox: true },
		},
	});
}

async function openIt(wrapper: ReturnType<typeof mountPopover>) {
	await wrapper.find('.trigger').trigger('click');
	await flushPromises();
}

describe('TaskCreatePopover', () => {
	it('renders its own trigger, labelled Make task unless told otherwise', () => {
		expect(mountPopover().find('[data-testid="task-create-trigger"]').text()).toContain(
			'Make task'
		);
		expect(mountPopover({ label: 'Follow up' }).text()).toContain('Follow up');
	});

	it('starts with the default title, as Only me, with the assignee picker shut', async () => {
		const wrapper = mountPopover({ defaultTitle: 'Send the contract' });
		await openIt(wrapper);
		const title = wrapper.find<HTMLInputElement>('[data-testid="task-create-title"]');
		expect(title.element.value).toBe('Send the contract');
		expect(wrapper.find('[data-audience="private"]').attributes('aria-checked')).toBe('true');
		expect(
			wrapper.find('[data-testid="task-assignee-picker"]').attributes('disabled')
		).toBeDefined();
	});

	it('creates the task for its conversation and company, then emits the id and offers Open', async () => {
		const wrapper = mountPopover({
			defaultTitle: 'Send the contract',
			mailThreadId: 'thread_1',
			companyKey: 'northwind.example',
		});
		await openIt(wrapper);
		await wrapper.find('[data-audience="group:g1"]').trigger('click');
		await wrapper.find('[data-testid="task-create-due"]').setValue('2026-11-12');
		await wrapper.find('form').trigger('submit');
		await flushPromises();

		expect(create).toHaveBeenCalledWith({
			title: 'Send the contract',
			visibility: 'group',
			groupId: 'g1',
			dueAt: new Date(2026, 10, 12, 12).getTime(),
			companyKey: 'northwind.example',
			mailThreadId: 'thread_1',
		});
		expect(wrapper.emitted('created')).toEqual([['task_1']]);
		expect(wrapper.find('.panel').exists()).toBe(false);
		const action = showToast.mock.calls[0]?.[2]?.action;
		action.onAction();
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/tasks?task=task_1');
	});

	it('creates nothing without a title', async () => {
		const wrapper = mountPopover();
		await openIt(wrapper);
		await wrapper.find('form').trigger('submit');
		await flushPromises();
		expect(create).not.toHaveBeenCalled();
		expect(wrapper.emitted('created')).toBeUndefined();
	});

	it('keeps the popover open when the backend refuses', async () => {
		create.mockResolvedValueOnce({ ok: false } as never);
		const wrapper = mountPopover({ defaultTitle: 'Call back' });
		await openIt(wrapper);
		await wrapper.find('form').trigger('submit');
		await flushPromises();
		expect(wrapper.find('.panel').exists()).toBe(true);
		expect(wrapper.emitted('created')).toBeUndefined();
	});
});
