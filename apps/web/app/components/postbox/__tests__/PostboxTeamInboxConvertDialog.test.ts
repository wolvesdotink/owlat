// @vitest-environment happy-dom
/**
 * TeamInboxConvertDialog — sharing one of the admin's own mailboxes as a team
 * inbox, from the admin Team inboxes page.
 *
 * What it must not get wrong:
 *  - the warning. Every message already in the mailbox becomes visible to the
 *    people added, so the dialog names the address before anyone confirms;
 *  - the roster. The admin stays the owner, so they are never offered as a
 *    member, and exactly the ticked teammates reach the backend.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref, defineComponent, h } from 'vue';
import { getFunctionName } from 'convex/server';
import type { Id } from '@owlat/api/dataModel';

import TeamInboxConvertDialog from '../TeamInboxConvertDialog.vue';
import PostboxTeamMemberPicker from '../PostboxTeamMemberPicker.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

const INFO = {
	mailboxId: 'mailbox_info' as Id<'mailboxes'>,
	address: 'info@owlat.test',
	displayName: 'Info',
};
const PERSONAL = {
	mailboxId: 'mailbox_me' as Id<'mailboxes'>,
	address: 'me@owlat.test',
	displayName: null,
};

const runs: { name: string; args: unknown }[] = [];

beforeEach(() => {
	runs.length = 0;
	vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'user_admin' }) }));
	vi.stubGlobal('useOrganization', () => ({
		members: ref([
			{ userId: 'user_admin', user: { name: 'Ada', email: 'ada@owlat.test' } },
			{ userId: 'user_ines', user: { name: 'Inés', email: 'ines@owlat.test' } },
			{ userId: 'user_tobias', user: { name: 'Tobias', email: 'tobias@owlat.test' } },
		]),
		fetchMembers: async () => {},
		isLoadingMembers: ref(false),
	}));
	vi.stubGlobal('useBackendOperation', (reference: Parameters<typeof getFunctionName>[0]) => ({
		run: async (args: unknown) => {
			runs.push({ name: getFunctionName(reference), args });
			return { ok: true, result: { mailboxId: INFO.mailboxId } };
		},
		isLoading: ref(false),
	}));
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const modalStub = defineComponent({
	props: { open: Boolean, title: { type: String, default: '' } },
	setup:
		(props, { slots }) =>
		() =>
			props.open ? h('div', [h('h2', props.title), slots.default?.(), slots.footer?.()]) : null,
});
const buttonStub = defineComponent({
	props: { disabled: Boolean, loading: Boolean },
	emits: ['click'],
	setup:
		(props, { slots, emit, attrs }) =>
		() =>
			h(
				'button',
				{ ...attrs, type: 'button', disabled: props.disabled, onClick: () => emit('click') },
				slots.default?.()
			),
});

const mountDialog = (mailboxes: (typeof INFO | typeof PERSONAL)[]) =>
	mount(TeamInboxConvertDialog, {
		props: { open: true, mailboxes },
		global: {
			plugins: [createTestI18n()],
			components: { PostboxTeamMemberPicker },
			stubs: { UiModal: modalStub, UiButton: buttonStub, Icon: true },
		},
	});

describe('TeamInboxConvertDialog', () => {
	it('shares the only offered mailbox with the ticked teammates', async () => {
		const wrapper = mountDialog([INFO]);
		await flushPromises();

		expect(wrapper.text()).toContain(
			'Everyone you add will see the mail already in info@owlat.test.'
		);
		expect((wrapper.find('#team-inbox-convert-name').element as HTMLInputElement).value).toBe(
			'Info'
		);
		// The admin stays the owner, so the picker offers everyone else.
		expect(wrapper.text()).not.toContain('ada@owlat.test');
		expectFullyLocalized(wrapper);

		const boxes = wrapper.findAll('input[type="checkbox"]');
		await boxes[0]!.setValue(true);
		await wrapper.find('[data-testid="team-inbox-convert-confirm"]').trigger('click');
		await flushPromises();

		expect(runs).toEqual([
			{
				name: 'mail/teamInboxConversion:convertToTeamInbox',
				args: { mailboxId: INFO.mailboxId, memberUserIds: ['user_ines'], displayName: 'Info' },
			},
		]);
		expect(wrapper.emitted('converted')).toEqual([
			[{ mailboxId: INFO.mailboxId, address: INFO.address }],
		]);
		expect(wrapper.emitted('update:open')).toEqual([[false]]);
	});

	it('makes the admin choose when there is more than one mailbox', async () => {
		const wrapper = mountDialog([INFO, PERSONAL]);
		await flushPromises();

		const confirm = wrapper.find('[data-testid="team-inbox-convert-confirm"]');
		expect(confirm.attributes('disabled')).toBeDefined();
		expect(wrapper.find('[data-testid="team-inbox-convert-warning"]').exists()).toBe(false);

		await wrapper.find('[data-testid="team-inbox-convert-mailbox"]').setValue(PERSONAL.mailboxId);
		expect(confirm.attributes('disabled')).toBeUndefined();
		expect(wrapper.find('[data-testid="team-inbox-convert-warning"]').text()).toContain(
			'me@owlat.test'
		);
	});
});
