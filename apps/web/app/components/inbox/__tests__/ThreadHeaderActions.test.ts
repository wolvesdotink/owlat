// @vitest-environment happy-dom
/**
 * The thread header's actions are described once and rendered twice (a row of
 * buttons on wide screens, one ⋯ menu below `sm`). Both renderings must offer
 * the same things and send the same events.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ThreadHeaderActions from '../ThreadHeaderActions.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n, navigateTo: () => undefined });
});

const button = {
	emits: ['click'],
	template:
		'<button type="button" @click="$emit(\'click\', $event)"><slot /><slot name="iconLeft" /></button>',
};

function mountActions(props: Record<string, unknown> = {}) {
	return mount(ThreadHeaderActions, {
		props: {
			isAdmin: true,
			chatEnabled: true,
			discussionChannels: [],
			members: [],
			currentUserId: 'me',
			assignedTo: null,
			assignedMemberName: null,
			isSnoozed: false,
			currentStatus: 'open',
			...props,
		},
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: true,
				UiAvatar: true,
				UiButton: button,
				InboxAssignPopover: { template: '<div><slot name="trigger" /></div>' },
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
				UiDropdownMenu: { template: '<div class="menu"><slot name="trigger" /><slot /></div>' },
				UiDropdownMenuItem: {
					emits: ['click'],
					template: '<button class="menu-item" @click="$emit(\'click\')"><slot /></button>',
				},
			},
		},
	});
}

describe('ThreadHeaderActions', () => {
	it('offers snooze and discuss in both the wide row and the compact menu', async () => {
		const wrapper = mountActions();
		const snoozes = wrapper.findAll('button').filter((b) => b.text() === 'Snooze');
		// One in the wide row, one in the ⋯ menu.
		expect(snoozes).toHaveLength(2);
		for (const snooze of snoozes) await snooze.trigger('click');
		expect(wrapper.emitted('snooze')).toHaveLength(2);
		const discuss = wrapper.findAll('button').filter((b) => b.text().includes('Discuss'));
		expect(discuss).toHaveLength(2);
	});

	it('links an existing chat channel on wide screens', () => {
		const wrapper = mountActions({ discussionChannels: [{ _id: 'c1', name: 'billing' }] });
		expect(wrapper.get('a[href="/dashboard/chat/c1"]').text()).toContain('#billing');
	});

	it('assigns to me from the compact menu, and unassigns when it is mine', async () => {
		const wrapper = mountActions();
		await wrapper
			.findAll('.menu-item')
			.find((item) => item.text() === 'Assign to me')!
			.trigger('click');
		expect(wrapper.emitted('assign')?.[0]).toEqual(['me']);

		const mine = mountActions({ assignedTo: 'me' });
		await mine
			.findAll('.menu-item')
			.find((item) => item.text() === 'Unassign me')!
			.trigger('click');
		expect(mine.emitted('assign')?.[0]).toEqual([undefined]);
	});
});
