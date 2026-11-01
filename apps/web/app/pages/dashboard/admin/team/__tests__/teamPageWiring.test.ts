/**
 * The team page, end to end through the members table, the pending invites and
 * the role summary. The page owns the roster writes and their toasts; these
 * cases drive each control and assert on what it calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, ref, type Ref } from 'vue';
import { flushPromises } from '@vue/test-utils';
import { installNuxtStubs, mountDashboardPage, queryResult } from '~/__tests__/a11y';
import { i18nStubs } from '~/__tests__/i18n';
import type { OrganizationInvitation, OrganizationMember } from '~/composables/useOrganization';
import TeamPage from '../index.vue';

const NOW = Date.parse('2026-08-21T09:12:00Z');
const DAY = 86_400_000;

const member = (id: string, role: string, name: string, email: string) =>
	({
		id,
		userId: `user_${id}`,
		role,
		createdAt: new Date(NOW - 30 * DAY),
		user: { id: `user_${id}`, name, email, image: null },
	}) as unknown as OrganizationMember;

const MEMBERS = [
	member('ada', 'owner', 'Ada Marlow', 'ada@owlat.example'),
	member('lin', 'admin', 'Lin Okafor', 'lin@owlat.example'),
	member('kim', 'editor', 'Kim Rendl', 'kim@owlat.example'),
];
const INVITES = [
	{
		id: 'inv_open',
		email: 'jo@owlat.example',
		role: 'editor',
		expiresAt: new Date(NOW + 2 * DAY + 3 * 3_600_000),
	},
	{ id: 'inv_gone', email: 'max@owlat.example', role: 'admin', expiresAt: new Date(NOW - DAY) },
] as unknown as OrganizationInvitation[];

const org = {
	updateRole: vi.fn(async () => undefined),
	remove: vi.fn(async () => undefined),
	transferOwnership: vi.fn(async () => undefined),
	cancelInvite: vi.fn(async () => undefined),
	resendInvite: vi.fn(async () => true),
	fetchMembers: vi.fn(async () => undefined),
};
const ops: Record<string, ReturnType<typeof vi.fn>> = {};
const showToast = vi.fn();
const copyLinkText = vi.fn();

const OpenWhen = (prop: string) =>
	defineComponent({
		props: { [prop]: { type: Object, default: null }, busy: Boolean },
		emits: ['close', 'confirm'],
		template: `<div v-if="${prop}" role="dialog" data-modal="${prop}"><button @click="$emit('confirm')">confirm-${prop}</button></div>`,
	});

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
	for (const fn of Object.values(org)) fn.mockClear();
	for (const key of Object.keys(ops)) delete ops[key];
	showToast.mockClear();
	copyLinkText.mockClear();
	installNuxtStubs({
		...i18nStubs,
		useToast: () => ({ showToast }),
		useOrganization: () => ({
			members: ref(MEMBERS),
			invitations: ref(INVITES),
			isLoading: ref(false),
			isLoadingMembers: ref(false),
			membersError: ref(null),
			canManageMembers: ref(true),
			isOwner: ref(true),
			...org,
		}),
		useTeamMembers: (members: Ref<OrganizationMember[]>) => {
			const memberSearch = ref('');
			const filteredMembers = computed(() =>
				members.value.filter((m) =>
					`${m.user.name} ${m.user.email}`
						.toLowerCase()
						.includes(memberSearch.value.trim().toLowerCase())
				)
			);
			return {
				memberSearch,
				filteredMembers,
				isMailboxStatusPending: ref(false),
				mailboxMetaFor: () => ({
					icon: 'lucide:mail',
					toneClass: '',
					label: 'Hosted',
					description: 'Hosted',
				}),
			};
		},
		useInviteLinks: () => ({
			buildAcceptUrl: (id: string) => `https://owlat.example/accept/${id}`,
			copyLinkText,
		}),
		useConvexQuery: () => queryResult(true),
		useBackendOperation: (_fn: unknown, options: { label: () => string }) => {
			const label = options.label();
			const run = vi.fn(async () => ({
				ok: true,
				result: { email: 'kim@owlat.example', alreadyVerified: false, sent: true },
			}));
			ops[label] = run;
			return { run, isLoading: ref(false) };
		},
	});
});

afterEach(() => {
	vi.useRealTimers();
});

function mountPage() {
	return mountDashboardPage(TeamPage, {
		stubs: {
			UiPageHeader: { template: '<header><slot name="actions" /></header>' },
			UiButton: { template: '<button v-bind="$attrs"><slot /></button>', inheritAttrs: false },
			UiTooltip: { template: '<span><slot /></span>' },
			UiInput: {
				props: ['modelValue', 'id'],
				emits: ['update:modelValue'],
				template:
					'<input :id="id" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
			},
			UiEmptyState: {
				props: ['title'],
				template: '<div><p>{{ title }}</p><slot name="action" /></div>',
			},
			UiDropdownMenu: { template: '<div class="menu"><slot name="trigger" /><slot /></div>' },
			UiDropdownMenuItem: {
				template: '<button class="menu-item" v-bind="$attrs"><slot /></button>',
			},
			UiDropdownDivider: true,
			DashboardDetailSkeleton: true,
			SettingsTeamRoleMenu: {
				props: ['role', 'memberLabel'],
				emits: ['change'],
				template:
					'<button class="role-menu" @click="$emit(\'change\', \'admin\')">{{ memberLabel }}</button>',
			},
			SettingsTeamInviteModal: true,
			SettingsTeamRemoveMemberModal: OpenWhen('member'),
			SettingsTeamTransferOwnershipModal: OpenWhen('member'),
			SettingsTeamCancelInviteModal: OpenWhen('invitation'),
		},
	});
}

const button = (wrapper: ReturnType<typeof mountPage>, label: string) =>
	wrapper.findAll('button').filter((b) => b.text().trim() === label);
const row = (wrapper: ReturnType<typeof mountPage>, email: string) =>
	wrapper.findAll('tbody tr').find((r) => r.text().includes(email))!;

describe('team page', () => {
	it('lists the roster, changes a role and filters by search', async () => {
		const wrapper = mountPage();
		expect(wrapper.text()).toContain('3 team members');
		expect(wrapper.findAll('tbody tr')).toHaveLength(3);
		// The owner's own row has no role menu and no actions.
		expect(row(wrapper, 'ada@owlat.example').find('.role-menu').exists()).toBe(false);
		expect(row(wrapper, 'ada@owlat.example').find('.menu').exists()).toBe(false);

		await row(wrapper, 'kim@owlat.example').get('.role-menu').trigger('click');
		await flushPromises();
		expect(org.updateRole).toHaveBeenCalledWith('kim', 'admin');
		expect(showToast).toHaveBeenLastCalledWith('Role updated successfully');

		await wrapper.get('#team-member-search').setValue('nobody');
		expect(wrapper.text()).toContain('No matches');
		await button(wrapper, 'Clear search')[0]!.trigger('click');
		expect(wrapper.findAll('tbody tr')).toHaveLength(3);
		wrapper.unmount();
	});

	it('runs the row actions: verify, resend verification, transfer and remove', async () => {
		const wrapper = mountPage();
		const kim = () => row(wrapper, 'kim@owlat.example');
		expect(kim().get('button[aria-label="Actions for Kim Rendl"]').exists()).toBe(true);

		await button(kim(), 'Mark email verified')[0]!.trigger('click');
		await flushPromises();
		expect(ops['Mark email verified']).toHaveBeenCalledWith({ userId: 'user_kim' });
		expect(showToast).toHaveBeenLastCalledWith('Marked kim@owlat.example as verified');

		await button(kim(), 'Resend verification email')[0]!.trigger('click');
		await flushPromises();
		expect(ops['Resend verification email']).toHaveBeenCalledWith({ userId: 'user_kim' });
		expect(showToast).toHaveBeenLastCalledWith('Verification email re-sent to kim@owlat.example');

		await button(kim(), 'Transfer ownership')[0]!.trigger('click');
		await button(wrapper, 'confirm-member')[0]!.trigger('click');
		await flushPromises();
		expect(org.transferOwnership).toHaveBeenCalledWith('kim');
		expect(showToast).toHaveBeenLastCalledWith('Ownership transferred successfully');

		await button(kim(), 'Remove from team')[0]!.trigger('click');
		await button(wrapper, 'confirm-member')[0]!.trigger('click');
		await flushPromises();
		expect(org.remove).toHaveBeenCalledWith('kim');
		expect(showToast).toHaveBeenLastCalledWith('Team member removed');
		expect(wrapper.find('[data-modal="member"]').exists()).toBe(false);
		wrapper.unmount();
	});

	it('copies, resends and revokes pending invites', async () => {
		const wrapper = mountPage();
		expect(wrapper.text()).toContain('2 pending invitations');
		expect(wrapper.text()).toContain('Expires in 2d 3h');
		expect(wrapper.text()).toContain('Expired');

		await wrapper.findAll('button[aria-label="Copy invite link"]')[0]!.trigger('click');
		expect(copyLinkText).toHaveBeenCalledWith('https://owlat.example/accept/inv_open');

		// Only the expired invite gets the labelled Resend button.
		const labelled = wrapper.findAll('[data-testid="invite-resend-labelled"]');
		expect(labelled).toHaveLength(1);
		await labelled[0]!.trigger('click');
		await flushPromises();
		expect(org.resendInvite).toHaveBeenCalledWith(INVITES[1]);
		expect(showToast).toHaveBeenLastCalledWith('Invitation re-sent to max@owlat.example');

		await wrapper.get('button[aria-label="Resend invitation email"]').trigger('click');
		await flushPromises();
		expect(org.resendInvite).toHaveBeenLastCalledWith(INVITES[0]);

		await wrapper.findAll('button[aria-label="Revoke invitation"]')[0]!.trigger('click');
		await button(wrapper, 'confirm-invitation')[0]!.trigger('click');
		await flushPromises();
		expect(org.cancelInvite).toHaveBeenCalledWith('inv_open', 'jo@owlat.example');
		expect(showToast).toHaveBeenLastCalledWith('Invitation cancelled');
		wrapper.unmount();
	});

	it('explains each role', () => {
		const wrapper = mountPage();
		expect(wrapper.text()).toContain('What each role can do');
		for (const role of ['Owner', 'Admin', 'Editor']) expect(wrapper.text()).toContain(role);
		wrapper.unmount();
	});
});
