// @vitest-environment happy-dom
/**
 * Today's inbox picker: the trigger says how many inboxes feed Today, each
 * row is a checkbox that reports its state, and a click asks for the opposite
 * of what the row shows. Mounted against the real `en` catalog.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import TodayInboxPicker from '../TodayInboxPicker.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const inbox = (mailboxId: string, name: string, scope: 'personal' | 'shared') => ({
	mailboxId: mailboxId as never,
	name,
	address: `${name.toLowerCase()}@owlat.test`,
	scope,
	slot: null,
	unread: 0,
});
const INBOXES = [inbox('mb_ada', 'Ada', 'personal'), inbox('mb_support', 'Support', 'shared')];

function mountPicker(hidden: string[]) {
	return mount(TodayInboxPicker, {
		props: { inboxes: INBOXES, hidden: hidden as never },
		global: {
			plugins: [createTestI18n()],
			stubs: {
				// Render the menu inline so the rows are in the tree.
				UiDropdownMenu: { template: '<div><slot name="trigger" /><slot /></div>' },
				UiDropdownDivider: true,
				UiButton: { template: '<button><slot /></button>' },
				Icon: true,
				InboxChip: { props: ['name'], template: '<span>{{ name }}</span>' },
			},
		},
	});
}

describe('TodayInboxPicker', () => {
	it('says "All inboxes" until one is left out, then counts', () => {
		expect(mountPicker([]).text()).toContain('All inboxes');
		expect(mountPicker(['mb_support']).text()).toContain('1 of 2 inboxes');
	});

	it('marks each row checked or not and toggles to the opposite', async () => {
		const w = mountPicker(['mb_support']);
		const rows = w.findAll('[role="menuitemcheckbox"]');
		expect(rows.map((r) => [r.text(), r.attributes('aria-checked')])).toEqual([
			['Ada', 'true'],
			['Support', 'false'],
		]);
		await rows[0]!.trigger('click');
		await rows[1]!.trigger('click');
		expect(w.emitted('toggle')).toEqual([
			['mb_ada', false],
			['mb_support', true],
		]);
	});

	it('tells the member where a hidden inbox still shows up', () => {
		expect(mountPicker([]).text()).toContain(
			'Hidden inboxes stay in the sidebar and the Answer queue.'
		);
	});
});
