/**
 * The mail settings pages name the mailbox they edit and switch it in place.
 *
 * Settings hides the Postbox sidebar and its switcher, so a page that read the
 * shared selection silently could set an auto-reply on the wrong mailbox. The
 * page runs on the real `usePostboxSettingsMailbox`; only the Convex reads and
 * the router are stubbed, so the mailbox the page edits is the one its reads
 * and saves name.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, reactive, ref, type Component } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { api } from '@owlat/api';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { usePostboxSettingsMailbox } from '~/composables/postbox/usePostboxSettingsMailbox';
import PreferencesMailboxPicker from '~/components/preferences/PreferencesMailboxPicker.vue';
import VacationPage from '../vacation.vue';
import SignaturesPage from '../signatures.vue';

const PERSONAL = { _id: 'mb_me', address: 'me@owlat.test', scope: 'personal', status: 'active' };
const SUPPORT = {
	_id: 'mb_support',
	address: 'support@owlat.test',
	displayName: 'Support',
	scope: 'shared',
	status: 'active',
};
const SALES = {
	_id: 'mb_sales',
	address: 'sales@owlat.test',
	displayName: 'Sales',
	scope: 'shared',
	status: 'active',
};

const responders: Record<string, { subject: string } | null> = {
	mb_me: { subject: 'Away from my desk' },
	mb_support: { subject: 'Support is closed this week' },
	mb_sales: null,
};

let mailboxes: Array<typeof PERSONAL | typeof SUPPORT>;
let roles: Array<{ mailboxId: string; role: 'owner' | 'member' }>;
const openMailboxId = ref<string | null>(null);
const route = reactive<{ query: Record<string, string>; hash: string }>({ query: {}, hash: '' });
const navigateTo = vi.fn((to: { query: Record<string, string> }) => {
	route.query = to.query;
});

function respond(name: string, args: Record<string, unknown>): unknown {
	if (name === getFunctionName(api.mail.mailboxMembers.myRoles)) return roles;
	if (name === getFunctionName(api.mail.vacation.get)) {
		const stored = responders[args['mailboxId'] as string];
		return stored
			? {
					isEnabled: true,
					subject: stored.subject,
					bodyText: 'Back soon',
					replyIntervalDays: 7,
				}
			: null;
	}
	return undefined;
}

const vacationReads = vi.fn();

function useConvexQuery(fn: FunctionReference<'query'>, args: () => unknown) {
	const name = getFunctionName(fn);
	return {
		data: computed(() => {
			const resolved = args();
			if (resolved === 'skip') return undefined;
			if (name === getFunctionName(api.mail.vacation.get)) vacationReads(resolved);
			return respond(name, resolved as Record<string, unknown>);
		}),
		isLoading: ref(false),
		error: ref(null),
		refetch: vi.fn(),
	};
}

beforeEach(() => {
	mailboxes = [PERSONAL, SUPPORT, SALES];
	roles = [
		{ mailboxId: 'mb_me', role: 'owner' },
		{ mailboxId: 'mb_support', role: 'owner' },
		{ mailboxId: 'mb_sales', role: 'member' },
	];
	openMailboxId.value = null;
	route.query = {};
	navigateTo.mockClear();
	vacationReads.mockClear();
	installNuxtStubs({
		...i18nStubs,
		useRoute: () => route,
		navigateTo,
		useConvexQuery,
		usePostboxMailbox: () => ({
			mailboxes: computed(() => mailboxes),
			currentMailbox: computed(
				() => mailboxes.find((m) => m._id === openMailboxId.value) ?? mailboxes[0] ?? null
			),
			isLoading: ref(false),
			error: ref(null),
			refetch: vi.fn(),
		}),
		usePostboxSettingsMailbox,
		useBackendOperation: () => ({ run: vi.fn(), isLoading: ref(false) }),
		usePostboxSignatures: () => ({
			signatures: ref([]),
			isLoading: ref(false),
			error: ref(null),
			refetch: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			remove: vi.fn(),
		}),
	});
});

function mountPage(page: Component) {
	return mount(page, {
		global: {
			plugins: [createTestI18n()],
			components: { PreferencesMailboxPicker },
			stubs: {
				UiQueryBoundary: { template: '<div><slot /></div>' },
				UiSwitch: true,
				UiSkeleton: true,
				UiConfirmationDialog: true,
				UiBadge: true,
				UiCheckbox: true,
				PostboxBasicEditor: true,
				UiButton: {
					inheritAttrs: false,
					template: '<button v-bind="$attrs"><slot /></button>',
				},
			},
		},
	});
}

const optionValues = (wrapper: ReturnType<typeof mountPage>) =>
	wrapper.findAll('#settings-mailbox option').map((o) => (o.element as HTMLOptionElement).value);

describe('the vacation reply names the mailbox it edits', () => {
	it('shows the address as plain text when there is only one mailbox to edit', async () => {
		mailboxes = [PERSONAL];
		roles = [{ mailboxId: 'mb_me', role: 'owner' }];
		const wrapper = mountPage(VacationPage);
		await flushPromises();

		expect(wrapper.get('[data-testid="settings-mailbox"]').text()).toContain('me@owlat.test');
		expect(wrapper.find('select#settings-mailbox').exists()).toBe(false);
	});

	it('opens on the mailbox open in the Postbox and offers only mailboxes it may save', async () => {
		openMailboxId.value = 'mb_support';
		const wrapper = mountPage(VacationPage);
		await flushPromises();

		const select = wrapper.get('select#settings-mailbox');
		expect((select.element as HTMLSelectElement).value).toBe('mb_support');
		// A team-inbox member reads the reply but every save is refused.
		expect(optionValues(wrapper)).toEqual(['mb_me', 'mb_support']);
		expect((wrapper.get('#draft-subject').element as HTMLInputElement).value).toBe(
			'Support is closed this week'
		);
	});

	it("loads the other mailbox's reply on a switch, without touching the Postbox selection", async () => {
		const wrapper = mountPage(VacationPage);
		await flushPromises();
		expect((wrapper.get('#draft-subject').element as HTMLInputElement).value).toBe(
			'Away from my desk'
		);

		await wrapper.get('select#settings-mailbox').setValue('mb_support');
		await flushPromises();

		expect(navigateTo).toHaveBeenCalledWith(
			expect.objectContaining({ query: { settingsMailbox: 'mb_support' } }),
			{ replace: true }
		);
		expect(vacationReads).toHaveBeenLastCalledWith({ mailboxId: 'mb_support' });
		expect((wrapper.get('#draft-subject').element as HTMLInputElement).value).toBe(
			'Support is closed this week'
		);
		expect(openMailboxId.value).toBeNull();
	});

	it('falls back to a mailbox it may edit when the Postbox has a member-only one open', async () => {
		openMailboxId.value = 'mb_sales';
		const wrapper = mountPage(VacationPage);
		await flushPromises();

		expect((wrapper.get('select#settings-mailbox').element as HTMLSelectElement).value).toBe(
			'mb_me'
		);
		expect(vacationReads).not.toHaveBeenCalledWith({ mailboxId: 'mb_sales' });
	});

	it('holds the switch while the reply has unsaved edits', async () => {
		const wrapper = mountPage(VacationPage);
		await flushPromises();
		const select = wrapper.get('select#settings-mailbox');
		expect(select.attributes('disabled')).toBeUndefined();

		await wrapper.get('#draft-subject').setValue('Gone fishing');
		expect(select.attributes('disabled')).toBeDefined();
	});
});

describe('signatures name their mailbox too', () => {
	it('offers a team inbox the viewer is only a member of, since members may save signatures', async () => {
		const wrapper = mountPage(SignaturesPage);
		await flushPromises();

		expect(optionValues(wrapper)).toEqual(['mb_me', 'mb_support', 'mb_sales']);
	});
});
