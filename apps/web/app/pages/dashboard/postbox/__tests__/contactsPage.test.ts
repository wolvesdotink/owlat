/**
 * The personal address book (/dashboard/postbox/contacts).
 *
 * This page is the ONLY surface that can create, correct or delete entries in
 * the per-mailbox `mail.contacts` dataset that feeds recipient autocomplete —
 * the /dashboard/audience pages manage a different, org-wide dataset. It was
 * once replaced by a redirect to those pages, which silently removed every
 * personal-contact management affordance while the postbox rail and the command
 * palette kept linking here; these tests pin the CRUD surface in place.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';

import { i18nStubs } from '~/__tests__/i18n';
import ContactsPage from '../contacts.vue';
import { mountDashboardPage } from '~/__tests__/a11y';

type Contact = {
	_id: string;
	email: string;
	displayName?: string;
	organization?: string;
	phones?: Array<{ value: string; type?: string }>;
	importedAt?: number;
	postalAddresses?: Array<{ street?: string }>;
	cardDavSource?: {
		accountId: string;
		href: string;
		etag: string;
		isRowCreatedBySync: boolean;
		editedAt?: number;
	};
};

const save = vi.fn(async () => ({ ok: true, result: 'contact-id' }));
const remove = vi.fn(async () => ({ ok: true, result: { photoRemovalId: 'job-1' } }));
const restore = vi.fn(async () => ({ ok: true, result: 'contact-id' }));
const resumeCardDav = vi.fn(async () => ({ ok: true, result: { isSyncScheduled: true } }));
const composerOpen = vi.fn();
const showToast = vi.fn();
const contacts = ref<Contact[]>([]);
const navigate = vi.fn();

beforeAll(() => {
	Object.assign(globalThis, {
		// `useI18n` is a Nuxt auto-import in the SFC — a bare global here.
		useI18n: i18nStubs.useI18n,
		useHead: () => {},
		definePageMeta: () => {},
		navigateTo: navigate,
		usePostboxMailbox: () => ({
			currentMailbox: ref({ _id: 'mailbox-1' }),
			isLoading: ref(false),
		}),
		usePostboxContacts: () => ({
			contacts,
			isLoading: ref(false),
			save,
			remove,
			restore,
			resumeCardDav,
		}),
		usePostboxComposeNav: () => ({ open: composerOpen }),
		useToast: () => ({ showToast }),
	});
});

const passthrough = (name: string) =>
	defineComponent({
		name,
		setup:
			(_p, { slots }) =>
			() =>
				h('div', slots.default?.()),
	});
/** UiModal teleports in production; rendering inline keeps the assertions simple. */
const modalStub = defineComponent({
	name: 'UiModal',
	props: { open: { type: Boolean, default: false }, title: { type: String, default: '' } },
	setup:
		(props, { slots }) =>
		() =>
			props.open ? h('div', { class: 'modal' }, slots.default?.()) : null,
});

let wrapper: VueWrapper | null = null;

function mountPage() {
	wrapper = mountDashboardPage(ContactsPage, {
		components: {
			UiModal: modalStub,
			PostboxMailboxGuard: passthrough('PostboxMailboxGuard'),
			PostboxContactsVcardActions: passthrough('PostboxContactsVcardActions'),
			PostboxContactsCardDavPanel: passthrough('PostboxContactsCardDavPanel'),
			LazyPostboxContactsCardDavPanel: passthrough('PostboxContactsCardDavPanel'),
			UiBadge: passthrough('UiBadge'),
		},
	});
	return wrapper;
}

beforeEach(() => {
	vi.clearAllMocks();
	contacts.value = [
		{
			_id: 'c1',
			email: 'ada@example.com',
			displayName: 'Ada Lovelace',
			organization: 'Analytical',
		},
		{ _id: 'c2', email: 'grace@example.com', displayName: 'Grace Hopper' },
	];
});

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

describe('postbox contacts page', () => {
	it('never redirects away — it manages the personal dataset itself', () => {
		mountPage();
		expect(navigate).not.toHaveBeenCalled();
	});

	it('lists the mailbox contacts', () => {
		const w = mountPage();
		expect(w.text()).toContain('Ada Lovelace');
		expect(w.text()).toContain('grace@example.com');
	});

	it('filters on name, address and organization', async () => {
		vi.useFakeTimers();
		try {
			const w = mountPage();
			const search = w.get('input[placeholder="Search contacts"]');

			await search.setValue('grace');
			await vi.advanceTimersByTimeAsync(100);
			expect(w.text()).not.toContain('Ada Lovelace');

			await search.setValue('analytical');
			await vi.advanceTimersByTimeAsync(100);
			expect(w.text()).toContain('Ada Lovelace');
			expect(w.text()).not.toContain('Grace Hopper');
		} finally {
			vi.useRealTimers();
		}
	});

	it('waits for a ~100ms pause in typing before re-filtering the list', async () => {
		vi.useFakeTimers();
		try {
			const w = mountPage();
			const search = w.get('input[placeholder="Search contacts"]');

			await search.setValue('gr');
			await vi.advanceTimersByTimeAsync(60);
			await search.setValue('grace');
			await vi.advanceTimersByTimeAsync(60);
			// Still mid-typing: the book is unfiltered.
			expect(w.text()).toContain('Ada Lovelace');

			await vi.advanceTimersByTimeAsync(40);
			expect(w.text()).not.toContain('Ada Lovelace');
			expect(w.text()).toContain('Grace Hopper');
		} finally {
			vi.useRealTimers();
		}
	});

	it('mounts only a window of a large address book, sized for the full list', () => {
		contacts.value = Array.from({ length: 500 }, (_, i) => ({
			_id: `c${i}`,
			email: `person${i}@example.com`,
			displayName: `Person ${i}`,
		}));
		const w = mountPage();
		const rows = w.findAll('li');
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.length).toBeLessThan(60);
		expect(w.text()).toContain('Person 0');
		expect(w.text()).not.toContain('Person 499');
		// Spacers stand in for every unmounted 64px row, so the page keeps its
		// full scroll height.
		const list = w.get('ul').element as HTMLElement;
		expect(list.style.paddingTop).toBe('0px');
		expect(list.style.paddingBottom).toBe(`${(500 - rows.length) * 64}px`);
	});

	it('follows the page scroll to mount the rows in view', async () => {
		contacts.value = Array.from({ length: 500 }, (_, i) => ({
			_id: `c${i}`,
			email: `person${i}@example.com`,
			displayName: `Person ${i}`,
		}));
		const w = mountPage();
		const doc = document.scrollingElement as HTMLElement;
		const list = w.get('ul').element as HTMLElement;
		list.getBoundingClientRect = () => ({ top: 150 - doc.scrollTop }) as DOMRect;
		doc.scrollTop = 150 + 300 * 64;
		window.dispatchEvent(new Event('scroll'));
		await vi.waitFor(() => expect(w.text()).toContain('Person 300'));
		expect(w.text()).not.toContain('Person 0 ');
		expect(w.findAll('li').length).toBeLessThan(60);
		doc.scrollTop = 0;
	});

	it('creates a contact through the personal data layer', async () => {
		const w = mountPage();
		const addButton = w.findAll('button').find((b) => b.text().includes('Add contact'));
		expect(addButton).toBeDefined();
		await addButton!.trigger('click');

		await w.get('#form-email').setValue('alan@example.com');
		await w.get('#form-displayname').setValue('Alan Turing');
		await w.get('form').trigger('submit');

		expect(save).toHaveBeenCalledWith({
			email: 'alan@example.com',
			displayName: 'Alan Turing',
			organization: undefined,
		});
	});

	it('edits an existing contact with its current values prefilled', async () => {
		const w = mountPage();
		await w.get('button[aria-label="Edit Ada Lovelace"]').trigger('click');

		expect((w.get('#form-email').element as HTMLInputElement).value).toBe('ada@example.com');
		expect((w.get('#form-organization').element as HTMLInputElement).value).toBe('Analytical');
	});

	it('removes a contact and offers an undo that restores the whole row', async () => {
		const w = mountPage();
		await w.get('button[aria-label="Remove Ada Lovelace"]').trigger('click');

		expect(remove).toHaveBeenCalledWith('c1');
		const [message, tone, options] = showToast.mock.calls[0] as [
			string,
			string,
			{ action: { label: string; onAction: () => void } },
		];
		expect(message).toContain('Ada Lovelace');
		expect(tone).toBe('success');
		expect(options.action.label).toBe('Undo');

		options.action.onAction();
		expect(restore).toHaveBeenCalledWith(contacts.value[0], 'job-1');
		expect(save).not.toHaveBeenCalled();
	});

	it('marks where each contact came from and shows its first phone number', () => {
		contacts.value = [
			{
				_id: 'c3',
				email: 'linus@example.net',
				displayName: 'Linus',
				phones: [{ value: '+1 555 0100', type: 'cell' }],
				importedAt: 1,
			},
			{ _id: 'c2', email: 'grace@example.com', displayName: 'Grace Hopper' },
		];
		const w = mountPage();
		const [imported, fromMail] = w.findAll('li');
		expect(imported!.text()).toContain('vCard');
		expect(imported!.text()).toContain('+1 555 0100');
		expect(fromMail!.text()).toContain('Mail');
		expect(fromMail!.text()).not.toContain('vCard');
	});

	it('undoes the removal of a synced contact with its details and picture', async () => {
		const ada = {
			_id: 'c4',
			email: 'ada@example.com',
			displayName: 'Ada',
			phones: [{ value: '+1 555 0100', type: 'cell' }],
			postalAddresses: [{ street: '12 St James Sq' }],
			cardDavSource: {
				accountId: 'a1',
				href: 'https://dav/ada.vcf',
				etag: '"1"',
				isRowCreatedBySync: true,
			},
		};
		contacts.value = [ada];
		const w = mountPage();
		await w.get('button[aria-label="Remove Ada"]').trigger('click');
		const [, , options] = showToast.mock.calls[0] as [
			string,
			string,
			{ action: { onAction: () => void } },
		];
		options.action.onAction();
		expect(restore).toHaveBeenCalledWith(ada, 'job-1');
		expect(save).not.toHaveBeenCalled();
	});

	it('shows a synced contact edited here as not following CardDAV, and resumes it', async () => {
		const link = { accountId: 'a1', href: 'https://dav/ada.vcf', etag: '"1"' };
		contacts.value = [
			{
				_id: 'c5',
				email: 'ada@example.com',
				displayName: 'Ada (mine)',
				cardDavSource: { ...link, isRowCreatedBySync: false, editedAt: 1 },
			},
			{
				_id: 'c6',
				email: 'linus@example.net',
				displayName: 'Linus',
				cardDavSource: { ...link, isRowCreatedBySync: true },
			},
		];
		const w = mountPage();
		const [edited, following] = w.findAll('li');
		expect(edited!.text()).toContain('Edited here, not following CardDAV');
		expect(following!.text()).toContain('CardDAV');
		expect(following!.text()).not.toContain('Edited here');
		expect(following!.text()).not.toContain('Resume CardDAV updates');

		const resume = edited!.findAll('button').find((b) => b.text() === 'Resume CardDAV updates');
		await resume!.trigger('click');
		expect(resumeCardDav).toHaveBeenCalledWith('c5');
		await vi.waitFor(() =>
			expect(showToast).toHaveBeenCalledWith(
				'Ada (mine) follows CardDAV again. The next sync brings back the card’s details.',
				'success'
			)
		);
	});

	it('opens the composer prefilled to the contact', async () => {
		const w = mountPage();
		await w.get('button[aria-label="Write to Ada Lovelace"]').trigger('click');

		expect(composerOpen).toHaveBeenCalledWith({
			mailboxId: 'mailbox-1',
			prefillTo: ['ada@example.com'],
		});
	});
});
