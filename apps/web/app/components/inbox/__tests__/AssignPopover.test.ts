/**
 * Assignee picker rows + selection:
 *   - "Me" is the first row and carries the assign-to-me key, as bound
 *   - activating a row (the keyboard Enter / click path on a menuitem) emits the
 *     chosen assignee — the viewer's id for "Me", the member id for a teammate
 *   - Unassign is offered only when the thread is currently assigned, and emits
 *     `undefined`
 *
 * The teleported UiDropdownMenu owns arrow/Enter navigation; here it is stubbed
 * to render its default slot so we can assert the row set + emit contract that a
 * keyboard selection resolves to.
 */
import { afterEach, beforeAll, describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import AssignPopover from '../AssignPopover.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { applyShortcutPreferences, resetShortcutPreferences } from '~/utils/shortcutScope';

const members = [
	{ userId: 'me-1', name: 'Ada Lovelace', email: 'ada@example.com', image: null },
	{ userId: 'u-2', name: 'Bo Diaz', email: 'bo@example.com', image: null },
	{ userId: 'u-3', name: null, email: 'cleo@example.com', image: null },
];

// Every visible string flows through vue-i18n now: mount with the real catalog
// and expose `useI18n`, which is a Nuxt auto-import in the app.
beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});
afterEach(() => resetShortcutPreferences());

const mountOpts = {
	global: {
		plugins: [createTestI18n()],
		stubs: {
			Icon: true,
			UiAvatar: true,
			// Render the default slot so the menu items are in the DOM.
			UiDropdownMenu: { template: '<div><slot /></div>' },
			UiDropdownDivider: { template: '<hr />' },
			UiDropdownMenuItem: {
				emits: ['click'],
				template: '<button class="menu-item" @click="$emit(\'click\', $event)"><slot /></button>',
			},
		},
	},
};

describe('AssignPopover', () => {
	it("hints the surface's own assign key, and follows a remap", () => {
		applyShortcutPreferences('owlat', [
			{ id: 'inbox.assignToMe', keys: ['m'] },
			{ id: 'inboxList.assignToMe', keys: ['y'] },
		]);
		const kbd = (props: Record<string, unknown>) =>
			mount(AssignPopover, { ...mountOpts, props: { members, currentUserId: 'me-1', ...props } })
				.find('kbd')
				.text();
		expect(kbd({})).toBe('M');
		expect(kbd({ assignShortcutId: 'inboxList.assignToMe' })).toBe('Y');
	});

	it('shows no hint when the key is unbound', () => {
		applyShortcutPreferences('owlat', [{ id: 'inbox.assignToMe', keys: [] }]);
		const wrapper = mount(AssignPopover, {
			...mountOpts,
			props: { members, currentUserId: 'me-1' },
		});
		expect(wrapper.find('kbd').exists()).toBe(false);
	});

	it('lists Me first with the I shortcut hint, then the other members', () => {
		const wrapper = mount(AssignPopover, {
			...mountOpts,
			props: { members, currentUserId: 'me-1' },
		});
		const items = wrapper.findAll('button.menu-item');
		// Me + two other members (unassigned → no Unassign row).
		expect(items).toHaveLength(3);
		expect(items[0]!.text()).toContain('Assign to me');
		expect(items[0]!.find('kbd').text()).toBe('I');
		expect(items[1]!.text()).toContain('Bo Diaz');
		expect(items[2]!.text()).toContain('cleo@example.com');
	});

	it('emits the viewer id when Me is selected', async () => {
		const wrapper = mount(AssignPopover, {
			...mountOpts,
			props: { members, currentUserId: 'me-1' },
		});
		await wrapper.findAll('button.menu-item')[0]!.trigger('click');
		expect(wrapper.emitted('assign')).toEqual([['me-1']]);
	});

	it('emits the member id when a teammate is selected', async () => {
		const wrapper = mount(AssignPopover, {
			...mountOpts,
			props: { members, currentUserId: 'me-1' },
		});
		await wrapper.findAll('button.menu-item')[1]!.trigger('click');
		expect(wrapper.emitted('assign')).toEqual([['u-2']]);
	});

	it('offers Unassign only when assigned, emitting undefined', async () => {
		const unassigned = mount(AssignPopover, {
			...mountOpts,
			props: { members, currentUserId: 'me-1', assignedTo: null },
		});
		expect(unassigned.text()).not.toContain('Unassign');

		const assigned = mount(AssignPopover, {
			...mountOpts,
			props: { members, currentUserId: 'me-1', assignedTo: 'u-2' },
		});
		const items = assigned.findAll('button.menu-item');
		const unassign = items[items.length - 1]!;
		expect(unassign.text()).toContain('Unassign');
		await unassign.trigger('click');
		expect(assigned.emitted('assign')).toEqual([[undefined]]);
	});
});
