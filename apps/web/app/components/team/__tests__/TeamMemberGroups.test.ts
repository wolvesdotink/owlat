/**
 * The Groups section of the Team page.
 *
 * What has to hold:
 *   - an admin with no groups gets a first action, and creating a group sends
 *     its name and the members picked from the roster in one write
 *   - an edit is saved as a rename plus one write per member who joins or
 *     leaves, and a member can be taken out straight from the card
 *   - a name another group has is refused before anything is sent
 *   - the server's refusal to delete a group that still has tasks is shown in
 *     the confirmation, which stays open
 *   - a member who is not an admin sees the groups and who is in them, with no
 *     way to change them
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { getFunctionName } from 'convex/server';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import TeamMemberGroups from '../TeamMemberGroups.vue';
import TeamMemberGroupDialog from '../TeamMemberGroupDialog.vue';
import TeamMemberPicker from '../TeamMemberPicker.vue';

type Group = { _id: string; name: string; memberUserIds: string[]; isMember: boolean };
type OperationError = { category: string; message: string };
type Opts = { onError?: (error: OperationError) => boolean };

const groups = ref<Group[] | undefined>([]);
let calls: Array<{ name: string; args: Record<string, unknown> }>;
let refuse: ((name: string) => OperationError | null) | null;
const toasts: string[] = [];

beforeEach(() => {
	groups.value = [];
	calls = [];
	refuse = null;
	toasts.length = 0;
	Object.assign(globalThis, i18nStubs);
	vi.stubGlobal('useToast', () => ({ showToast: (message: string) => toasts.push(message) }));
	vi.stubGlobal('useConvexQuery', () => ({ data: groups, error: ref(null), refetch: vi.fn() }));
	vi.stubGlobal('useBackendOperation', (reference: unknown, opts: Opts) => ({
		isLoading: ref(false),
		inlineError: ref(null),
		run: async (args: Record<string, unknown>) => {
			const name = getFunctionName(reference as never);
			calls.push({ name, args });
			const error = refuse?.(name) ?? null;
			if (error) {
				opts.onError?.(error);
				return { ok: false };
			}
			return { ok: true, result: null };
		},
	}));
});

const roster = [
	{
		id: 'm1',
		userId: 'u_ana',
		user: { id: 'u_ana', name: 'Ana Ruiz', email: 'ana@owlat.example' },
	},
	{ id: 'm2', userId: 'u_ben', user: { id: 'u_ben', name: 'Ben Ott', email: 'ben@owlat.example' } },
	{ id: 'm3', userId: 'u_cem', user: { id: 'u_cem', name: '', email: 'cem@owlat.example' } },
];

const Modal = defineComponent({
	props: { open: Boolean, title: String },
	setup(props, { slots }) {
		return () =>
			props.open
				? h('div', { 'data-testid': 'modal' }, [
						h('h2', props.title),
						slots.default?.(),
						slots.footer?.(),
					])
				: null;
	},
});

const ConfirmationDialog = defineComponent({
	props: { open: Boolean, title: String, description: String, confirmText: String },
	emits: ['confirm', 'update:open'],
	setup(props, { slots, emit }) {
		return () =>
			props.open
				? h('div', { 'data-testid': 'confirm' }, [
						h('h2', props.title),
						h('p', props.description),
						slots.default?.(),
						h(
							'button',
							{ 'data-testid': 'confirm-yes', onClick: () => emit('confirm') },
							props.confirmText
						),
					])
				: null;
	},
});

const stubs = {
	UiCard: { template: '<div><slot name="header" /><slot /></div>' },
	UiEmptyState: {
		props: ['title', 'description', 'icon'],
		template: '<div><h3>{{ title }}</h3><p>{{ description }}</p><slot name="action" /></div>',
	},
	UiButton: {
		props: ['variant', 'size', 'loading', 'disabled'],
		template:
			'<button type="button" :disabled="disabled"><slot name="iconLeft" /><slot /></button>',
	},
	UiInput: {
		props: ['modelValue', 'label', 'error', 'id', 'placeholder', 'disabled', 'size'],
		emits: ['update:modelValue'],
		template: `<div><label :for="id">{{ label }}</label>
			<input :id="id" :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" />
			<p v-if="error" data-testid="input-error">{{ error }}</p></div>`,
	},
	UiDropdownMenu: { template: '<div><slot name="trigger" /><slot /></div>' },
	UiDropdownMenuItem: {
		props: ['icon', 'danger'],
		template: '<button type="button" class="menu-item"><slot /></button>',
	},
	UiDropdownDivider: true,
	UiAvatar: { props: ['name', 'email', 'image', 'size'], template: '<span class="avatar" />' },
	UiIconBox: true,
	UiBadge: { template: '<span class="badge"><slot /></span>' },
	UiSkeletonRow: true,
	UiModal: Modal,
	UiConfirmationDialog: ConfirmationDialog,
};

function mountSection(canManage = true) {
	return mount(TeamMemberGroups, {
		props: { members: roster as never, canManage },
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			stubs,
			components: { TeamMemberGroupDialog, TeamMemberPicker },
		},
	});
}

function pickerRow(wrapper: ReturnType<typeof mountSection>, text: string) {
	const row = wrapper
		.findAll('[data-testid="member-picker-row"]')
		.find((candidate) => candidate.text().includes(text));
	if (!row) throw new Error(`no picker row for ${text}`);
	return row.get('input[type="checkbox"]');
}

const mgmt: Group = {
	_id: 'g_mgmt',
	name: 'Management',
	memberUserIds: ['u_ana', 'u_ben'],
	isMember: true,
};

describe('TeamMemberGroups, as an admin', () => {
	it('offers a first group and creates it with the picked members', async () => {
		const wrapper = mountSection();
		expect(wrapper.text()).toContain(
			'Show a task only to the people in a group, such as Management.'
		);
		expect(wrapper.text()).toContain('No groups yet');

		await wrapper.get('[data-testid="member-groups-create-first"]').trigger('click');
		await wrapper.get('[data-testid="modal"] input').setValue('  Management  ');
		await pickerRow(wrapper, 'Ana Ruiz').setValue(true);
		await pickerRow(wrapper, 'cem@owlat.example').setValue(true);
		expect(wrapper.text()).toContain('2 selected');
		await wrapper.get('[data-testid="member-group-save"]').trigger('click');
		await flushPromises();

		expect(calls).toEqual([
			{
				name: 'tasks/groups:create',
				args: { name: 'Management', memberUserIds: ['u_ana', 'u_cem'] },
			},
		]);
		expect(toasts).toEqual(['Group Management created']);
		expect(wrapper.find('[data-testid="modal"]').exists()).toBe(false);
		wrapper.unmount();
	});

	it('refuses a name another group already has, before sending anything', async () => {
		groups.value = [mgmt];
		const wrapper = mountSection();
		await wrapper.get('[data-testid="member-groups-new"]').trigger('click');
		await wrapper.get('[data-testid="modal"] input').setValue('management');
		await wrapper.get('[data-testid="member-group-save"]').trigger('click');
		await flushPromises();

		expect(calls).toEqual([]);
		expect(wrapper.get('[data-testid="input-error"]').text()).toBe(
			'There is already a group called management.'
		);
		wrapper.unmount();
	});

	it('shows each group with its count, and its members on demand', async () => {
		groups.value = [mgmt, { _id: 'g_prod', name: 'Product', memberUserIds: [], isMember: false }];
		const wrapper = mountSection();
		const rows = wrapper.findAll('[data-testid="member-group-row"]');
		expect(rows).toHaveLength(2);
		expect(rows[0]!.text()).toContain('Management');
		expect(rows[0]!.text()).toContain("You're a member");
		expect(rows[0]!.text()).toContain('2 members');
		expect(rows[1]!.text()).toContain('No members');

		const toggle = rows[0]!.get('[data-testid="member-group-toggle"]');
		expect(toggle.attributes('aria-expanded')).toBe('false');
		await toggle.trigger('click');
		expect(toggle.attributes('aria-expanded')).toBe('true');
		const list = rows[0]!.get('[data-testid="member-group-members"]');
		expect(list.text()).toContain('Ana Ruiz');
		expect(list.text()).toContain('ben@owlat.example');
		wrapper.unmount();
	});

	it('takes a member out of a group from the card', async () => {
		groups.value = [mgmt];
		const wrapper = mountSection();
		await wrapper.get('[data-testid="member-group-toggle"]').trigger('click');
		const remove = wrapper.findAll('[data-testid="member-group-remove-member"]');
		expect(remove[1]!.attributes('aria-label')).toBe('Remove Ben Ott from Management');
		await remove[1]!.trigger('click');
		await flushPromises();

		expect(calls).toEqual([
			{ name: 'tasks/groups:removeMember', args: { groupId: 'g_mgmt', userId: 'u_ben' } },
		]);
		expect(toasts).toEqual(['Ben Ott removed from Management']);
		wrapper.unmount();
	});

	it('saves an edit as a rename and one write per member who joins or leaves', async () => {
		groups.value = [mgmt];
		const wrapper = mountSection();
		const edit = wrapper.findAll('.menu-item').find((item) => item.text() === 'Edit group');
		await edit!.trigger('click');
		await nextTick();
		await wrapper.get('[data-testid="modal"] input').setValue('Leadership');
		await pickerRow(wrapper, 'Ana Ruiz').setValue(false);
		await pickerRow(wrapper, 'cem@owlat.example').setValue(true);
		await wrapper.get('[data-testid="member-group-save"]').trigger('click');
		await flushPromises();

		expect(calls).toEqual([
			{ name: 'tasks/groups:rename', args: { groupId: 'g_mgmt', name: 'Leadership' } },
			{ name: 'tasks/groups:addMember', args: { groupId: 'g_mgmt', userId: 'u_cem' } },
			{ name: 'tasks/groups:removeMember', args: { groupId: 'g_mgmt', userId: 'u_ana' } },
		]);
		expect(toasts).toEqual(['Group Leadership saved']);
		wrapper.unmount();
	});

	it('keeps the delete confirmation open with the reason when the group still has tasks', async () => {
		groups.value = [mgmt];
		refuse = (name) =>
			name === 'tasks/groups:remove'
				? {
						category: 'invalid_state',
						message: 'This group still has tasks. Move them to another group first.',
					}
				: null;
		const wrapper = mountSection();
		const del = wrapper.findAll('.menu-item').find((item) => item.text() === 'Delete group');
		await del!.trigger('click');
		expect(wrapper.get('[data-testid="confirm"]').text()).toContain('Delete Management?');
		await wrapper.get('[data-testid="confirm-yes"]').trigger('click');
		await flushPromises();

		expect(calls).toEqual([{ name: 'tasks/groups:remove', args: { groupId: 'g_mgmt' } }]);
		expect(wrapper.get('[data-testid="member-group-delete-error"]').text()).toBe(
			'This group still has tasks. Move them to another group first.'
		);
		expect(wrapper.find('[data-testid="confirm"]').exists()).toBe(true);
		expect(toasts).toEqual([]);
		wrapper.unmount();
	});

	it('deletes a group without tasks and closes the confirmation', async () => {
		groups.value = [mgmt];
		const wrapper = mountSection();
		const del = wrapper.findAll('.menu-item').find((item) => item.text() === 'Delete group');
		await del!.trigger('click');
		await wrapper.get('[data-testid="confirm-yes"]').trigger('click');
		await flushPromises();

		expect(toasts).toEqual(['Group Management deleted']);
		expect(wrapper.find('[data-testid="confirm"]').exists()).toBe(false);
		wrapper.unmount();
	});
});

describe('TeamMemberGroups, as a member', () => {
	it('shows the groups and who is in them, with nothing to change', async () => {
		groups.value = [{ ...mgmt, isMember: false }];
		const wrapper = mountSection(false);
		expect(wrapper.find('[data-testid="member-groups-new"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="member-group-menu"]').exists()).toBe(false);

		await wrapper.get('[data-testid="member-group-toggle"]').trigger('click');
		expect(wrapper.get('[data-testid="member-group-members"]').text()).toContain('Ana Ruiz');
		expect(wrapper.find('[data-testid="member-group-remove-member"]').exists()).toBe(false);
		wrapper.unmount();
	});

	it('says who can create groups instead of offering to', () => {
		const wrapper = mountSection(false);
		expect(wrapper.text()).toContain(
			'Owners and admins can create groups, such as Management or Product.'
		);
		expect(wrapper.find('[data-testid="member-groups-create-first"]').exists()).toBe(false);
		wrapper.unmount();
	});
});
