// @vitest-environment happy-dom
/**
 * A saved-block card offers its writes twice, on the hover overlay and in the
 * overflow menu. Both must follow `canManage`, and both must hand the block
 * itself to the page (the delete dialog reads its name and usage count).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

import BlockCard from '../BlockCard.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeEach(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

const block = {
	_id: 'bl_1',
	name: 'Customer quote',
	description: 'Pull quote with a portrait',
	usageCount: 7,
	blockCount: 3,
	updatedAt: Date.parse('2026-06-02T09:00:00Z'),
};

function render(canManage: boolean) {
	return mount(BlockCard, {
		props: { block: block as never, canManage },
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: true,
				UiCard: { template: '<div class="card"><slot /></div>' },
				UiButton: { template: '<button class="trigger"><slot /></button>' },
				UiDropdownMenu: { template: '<div role="menu"><slot name="trigger" /><slot /></div>' },
				UiDropdownMenuItem: {
					emits: ['click'],
					template: '<button role="menuitem" @click="$emit(\'click\')"><slot /></button>',
				},
				UiDropdownDivider: true,
			},
		},
	});
}

const menuItem = (wrapper: ReturnType<typeof render>, label: string) =>
	wrapper.findAll('[role="menuitem"]').find((item) => item.text() === label);

describe('BlockCard', () => {
	it('shows the name, the description and the usage badges', () => {
		const text = render(true).text();
		expect(text).toContain('Customer quote');
		expect(text).toContain('Pull quote with a portrait');
		expect(text).toContain('7 uses');
		expect(text).toContain('3 blocks');
	});

	it('hands the block to the page from the menu and the overlay', async () => {
		const wrapper = render(true);
		await menuItem(wrapper, 'Delete')!.trigger('click');
		await wrapper.get('button[title="Delete"]').trigger('click');
		expect(wrapper.emitted('delete')).toEqual([[block], [block]]);

		await menuItem(wrapper, 'Settings')!.trigger('click');
		await wrapper.get('button[title="Quick settings"]').trigger('click');
		expect(wrapper.emitted('settings')).toHaveLength(2);

		await menuItem(wrapper, 'Duplicate')!.trigger('click');
		expect(wrapper.emitted('duplicate')).toEqual([[block]]);
	});

	it('opens the content editor from a card click without a second open from the overlay', async () => {
		const wrapper = render(true);
		await wrapper.get('.card').trigger('click');
		expect(wrapper.emitted('open')).toEqual([[block]]);
		await wrapper.get('button[title="Edit content"]').trigger('click');
		// `.stop` keeps the overlay click from also reaching the card.
		expect(wrapper.emitted('open')).toHaveLength(2);
	});

	it('takes every write off both controls without manage rights', () => {
		const wrapper = render(false);
		for (const title of ['Quick settings', 'Duplicate', 'Delete']) {
			expect(wrapper.find(`button[title="${title}"]`).exists()).toBe(false);
		}
		expect(wrapper.findAll('[role="menuitem"]').map((item) => item.text())).toEqual([
			'Edit content',
		]);
	});
});
