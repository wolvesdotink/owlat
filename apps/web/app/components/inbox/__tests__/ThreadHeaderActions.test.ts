/**
 * The thread header's actions are described once and rendered twice (a row of
 * buttons on wide screens, one ⋯ menu below `sm`). Both renderings must offer
 * the same things and send the same events.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ThreadHeaderActions from '../ThreadHeaderActions.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { applyShortcutPreferences, resetShortcutPreferences } from '~/utils/shortcutScope';

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

afterEach(() => resetShortcutPreferences());

describe('ThreadHeaderActions', () => {
	it("announces the Reply button's key as the person has it bound", () => {
		const reply = () => mountActions().get('[data-testid="thread-reply"]');
		expect(reply().attributes('aria-keyshortcuts')).toBe('r');
		applyShortcutPreferences('owlat', [{ id: 'inbox.reply', keys: ['y'] }]);
		expect(reply().attributes('aria-keyshortcuts')).toBe('y');
	});

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

	it('copies the link and shares it in chat from both menus', async () => {
		const wrapper = mountActions({ discussionChannels: [{ _id: 'c1', name: 'billing' }] });
		const copy = wrapper.findAll('.menu-item').filter((b) => b.text() === 'Copy link');
		const share = wrapper.findAll('.menu-item').filter((b) => b.text() === 'Share in chat…');
		// The wide ⋯ menu stays even with no discussion to start, plus the compact one.
		expect(copy).toHaveLength(2);
		expect(share).toHaveLength(2);
		for (const item of copy) await item.trigger('click');
		await share[0]!.trigger('click');
		expect(wrapper.emitted('copyLink')).toHaveLength(2);
		expect(wrapper.emitted('shareInChat')).toHaveLength(1);
	});

	it('offers no chat sharing while chat is off', () => {
		const wrapper = mountActions({ chatEnabled: false });
		const texts = wrapper.findAll('.menu-item').map((item) => item.text());
		expect(texts.filter((text) => text === 'Copy link')).toHaveLength(2);
		expect(texts).not.toContain('Share in chat…');
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

	it('names the current status on the trigger and checks it in both menus', () => {
		const wrapper = mountActions({ currentStatus: 'waiting' });
		const trigger = wrapper.get('[data-testid="thread-status"]');
		expect(trigger.attributes('aria-label')).toBe('Status: Waiting. Change thread status');
		expect(trigger.text()).toContain('Waiting');

		const radios = wrapper.findAll('[role="menuitemradio"]');
		// Three statuses, rendered in the wide menu and the compact one.
		expect(radios).toHaveLength(6);
		const checked = radios.filter((r) => r.attributes('aria-checked') === 'true');
		expect(checked).toHaveLength(2);
	});
});
