// @vitest-environment happy-dom
/**
 * Behaviour of the app-wide command palette that only exists once it is MOUNTED.
 *
 * The scoring, mode grammar and argument-group building are pure and pinned in
 * `lib/__tests__/commandPalette.test.ts`. What cannot be asserted there is the
 * wiring this file covers: that mail hits reach the list at all, that opening
 * one first points the Postbox selection at the message's own mailbox (a hit
 * from a team inbox opens against the wrong mailbox otherwise), that a typed
 * `>` actually narrows the rendered groups, and that an item carrying an
 * argument spec asks instead of running.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { dashboardShellStubs, installNuxtStubs, queryResult } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useCommandPaletteProviders } from '~/composables/useCommandPaletteProviders';
import { useCommandPaletteRecents } from '~/composables/useCommandPaletteRecents';
import { useDebouncedSearch } from '~/composables/useDebouncedSearch';
import { COMMAND_PALETTE_OPEN_EVENT } from '~/composables/useCommandPalette';
import type { CommandPaletteProvider } from '~/lib/commandPaletteRegistry';
import type { SearchResults } from '~/lib/commandPaletteCore';
import AppCommandPalette from '../AppCommandPalette.vue';

const searchResults: SearchResults = {
	contacts: [
		{
			id: 'contact1',
			type: 'contact',
			title: 'Ada Lovelace',
			subtitle: 'ada@example.com',
			url: '/dashboard/audience/contacts/contact1',
		},
	],
	emails: [],
	campaigns: [],
	mail: [
		{
			id: 'message1',
			type: 'mail',
			title: 'Invoice 4471 looks wrong',
			subtitle: 'Ada Lovelace · we were double charged',
			url: '/dashboard/postbox/inbox/message1',
			mailboxId: 'mailbox-team',
		},
	],
};

const setActiveMailboxId = vi.fn();
const navigateTo = vi.fn();
const runLabelOption = vi.fn();
const runParentItem = vi.fn();

/** An external provider contributing one argument item, like "Label as…". */
function argumentProvider(): CommandPaletteProvider {
	return {
		id: 'surface:test',
		priority: 10,
		build: () => [
			{
				key: 'test-surface',
				heading: 'common.create',
				order: -5,
				mode: 'commands',
				items: [
					{
						id: 'test:label-as',
						label: 'Label as',
						icon: 'lucide:tag',
						run: runParentItem,
						argument: {
							promptKey: 'common.create',
							headingKey: 'common.create',
							icon: 'lucide:tag',
							options: [{ id: 'work', label: 'Work label', run: runLabelOption }],
						},
					},
				],
			},
		],
	};
}

beforeEach(() => {
	setActiveMailboxId.mockClear();
	navigateTo.mockClear();
	runLabelOption.mockClear();
	runParentItem.mockClear();
	installNuxtStubs({
		...i18nStubs,
		...dashboardShellStubs(),
		useRoute: () => ({
			path: '/dashboard/campaigns',
			fullPath: '/dashboard/campaigns',
			name: 'dashboard-campaigns',
			query: {},
			params: {},
			meta: {},
		}),
		navigateTo,
		useCommandPaletteProviders,
		useCommandPaletteRegistry: () => ref([argumentProvider()]),
		useCommandPaletteRecents,
		useDebouncedSearch,
		useModalFocus: vi.fn(),
		usePostboxActiveMailbox: () => ({ activeMailboxId: ref(null), setActiveMailboxId }),
		COMMAND_PALETTE_OPEN_EVENT,
		useOrganizationQuery: () => queryResult(searchResults),
	});
});

// The palette teleports into <body>, so a wrapper left mounted would leak its
// markup into the next test's assertions.
let wrapper: VueWrapper | null = null;

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
	document.body.innerHTML = '';
});

/** Mount the palette and open it the way every affordance in the app does. */
async function openPalette() {
	wrapper = mount(AppCommandPalette, {
		attachTo: document.body,
		global: { plugins: [createTestI18n()], stubs: { Icon: true, UiSpinner: true } },
	});
	window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT));
	await nextTick();
}

/** Type into the palette input (the whole list re-derives from it). */
async function type(text: string) {
	const input = document.body.querySelector('input');
	if (!input) throw new Error('palette input missing');
	input.value = text;
	input.dispatchEvent(new Event('input'));
	await nextTick();
	await nextTick();
}

function rows(): HTMLElement[] {
	return [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
}

function rowLabelled(text: string): HTMLElement {
	const found = rows().find((row) => row.textContent?.includes(text));
	if (!found) throw new Error(`no palette row containing "${text}" (had: ${rows().length} rows)`);
	return found;
}

describe('AppCommandPalette — mail results', () => {
	it('lists mail hits and the search-all-mail row for a typed query', async () => {
		await openPalette();
		await type('invoice');

		expect(document.body.textContent).toContain('Mail');
		expect(document.body.textContent).toContain('Invoice 4471 looks wrong');
		expect(document.body.textContent).toContain('Search mail for "invoice"');
	});

	it('points the Postbox selection at the hit’s own mailbox before opening it', async () => {
		await openPalette();
		await type('invoice');
		rowLabelled('Invoice 4471').click();

		expect(setActiveMailboxId).toHaveBeenCalledWith('mailbox-team');
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/postbox/inbox/message1');
	});

	it('sends the search-all-mail row to the Postbox search with the query', async () => {
		await openPalette();
		await type('invoice');
		rowLabelled('Search mail for').click();

		expect(navigateTo).toHaveBeenCalledWith({
			path: '/dashboard/postbox/search',
			query: { q: 'invoice' },
		});
	});
});

describe('AppCommandPalette — mode prefixes', () => {
	it('drops the people/mail groups when the query is prefixed with >', async () => {
		await openPalette();
		await type('ada');
		expect(document.body.textContent).toContain('Ada Lovelace');

		await type('>ada');
		expect(document.body.textContent).not.toContain('Ada Lovelace');
		expect(document.body.textContent).not.toContain('Invoice 4471');
		// The command-ish groups survive the narrowing.
		expect(document.body.textContent).toContain('Label as');
	});

	it('keeps only people for @ and strips the prefix from the search', async () => {
		await openPalette();
		await type('@ada');

		expect(document.body.textContent).toContain('Ada Lovelace');
		expect(document.body.textContent).not.toContain('Label as');
	});
});

describe('AppCommandPalette — argument mode', () => {
	it('asks for the argument instead of running the item, then runs the option', async () => {
		await openPalette();
		rowLabelled('Label as').click();
		await nextTick();

		expect(runParentItem).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain('Work label');
		// Only the option list is offered — the rest of the palette is gone.
		expect(rows()).toHaveLength(1);

		rowLabelled('Work label').click();
		expect(runLabelOption).toHaveBeenCalledOnce();
	});

	it('backs out of the argument step on Escape without closing the palette', async () => {
		await openPalette();
		rowLabelled('Label as').click();
		await nextTick();
		expect(rows()).toHaveLength(1);

		const input = document.body.querySelector('input');
		input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await nextTick();

		expect(document.body.querySelector('input')).not.toBeNull();
		expect(rows().length).toBeGreaterThan(1);
	});
});
