// @vitest-environment happy-dom
/**
 * The mailbox switcher, now an identity chip.
 *
 * Two things had to survive the shrink: a lone personal mailbox still renders
 * NOTHING (a chip offering one choice is chrome), and the per-mailbox unread
 * counts that used to sit in the rail are still readable — they moved into the
 * menu, so the assertions follow them there rather than disappearing.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxMailboxSwitcher from '../PostboxMailboxSwitcher.vue';

type Section = { mailboxId: string; label: string; unread: number };
const sections = ref<{ personal: Section[]; team: Section[] }>({ personal: [], team: [] });
const switchToMailbox = vi.fn();

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		usePostboxMailbox: () => ({ sections, switchToMailbox }),
	});
});

const iconStub = { props: ['name'], template: '<span class="icon" :data-name="name" />' };
// The real dropdown teleports its menu to <body>; render it inline so the menu
// contents are assertable in the wrapper.
const dropdownStub = {
	props: ['open', 'position'],
	template: '<div class="dropdown"><slot name="trigger" /><div class="menu"><slot /></div></div>',
};
const dropdownItemStub = {
	props: ['icon'],
	emits: ['click'],
	template: '<button class="menu-item" @click="$emit(\'click\', $event)"><slot /></button>',
};

function mountSwitcher(collapsed = false) {
	return mount(PostboxMailboxSwitcher, {
		props: { mailboxId: 'mb-1' as never, collapsed },
		global: {
			plugins: [createTestI18n()],
			components: {
				Icon: iconStub,
				UiDropdownMenu: dropdownStub,
				UiDropdownMenuItem: dropdownItemStub,
			},
		},
	});
}

describe('PostboxMailboxSwitcher', () => {
	it('renders nothing for a lone personal mailbox', () => {
		sections.value = { personal: [{ mailboxId: 'mb-1', label: 'Ada', unread: 4 }], team: [] };
		expect(mountSwitcher().find('.dropdown').exists()).toBe(false);
	});

	it('is a chip naming the active mailbox once there is a choice', () => {
		sections.value = {
			personal: [{ mailboxId: 'mb-1', label: 'Ada', unread: 4 }],
			team: [{ mailboxId: 'mb-2', label: 'Support', unread: 7 }],
		};
		const w = mountSwitcher();
		expect(w.get('.dropdown').exists()).toBe(true);
		expect(w.get('button').text()).toContain('Ada');
	});

	it('keeps the per-mailbox unread counts, in the menu', () => {
		sections.value = {
			personal: [{ mailboxId: 'mb-1', label: 'Ada', unread: 4 }],
			team: [{ mailboxId: 'mb-2', label: 'Support', unread: 7 }],
		};
		const menu = mountSwitcher().get('.menu');
		expect(menu.text()).toContain('Support');
		expect(menu.text()).toContain('7');
	});

	it('switches on selection and ignores the mailbox already open', async () => {
		sections.value = {
			personal: [{ mailboxId: 'mb-1', label: 'Ada', unread: 0 }],
			team: [{ mailboxId: 'mb-2', label: 'Support', unread: 7 }],
		};
		const w = mountSwitcher();
		const items = w.findAll('.menu-item');
		await items[0]!.trigger('click');
		expect(switchToMailbox).not.toHaveBeenCalled();
		await items[1]!.trigger('click');
		expect(switchToMailbox).toHaveBeenCalledWith('mb-2');
	});
});
