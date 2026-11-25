/**
 * The mail settings pages name the mailbox they edit and switch it in place.
 *
 * Settings hides the Postbox sidebar and its switcher, so a page that read the
 * shared selection silently could set an auto-reply on the wrong mailbox. The
 * page runs on the real `usePostboxSettingsMailbox`; only the Convex reads and
 * the router are stubbed, so the mailbox the page edits is the one its reads
 * and saves name. `useState` is keyed as in Nuxt, so a choice made on one page
 * is still there when the next one mounts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, reactive, ref, type Component, type Ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { api } from '@owlat/api';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { usePostboxSettingsMailbox } from '~/composables/postbox/usePostboxSettingsMailbox';
import PreferencesMailboxPicker from '~/components/preferences/PreferencesMailboxPicker.vue';
import PostboxPlainRules from '~/components/postbox/PostboxPlainRules.vue';
import PostboxFilterReachNotice from '~/components/postbox/PostboxFilterReachNotice.vue';
import PostboxFilterRunsOnApplyBadge from '~/components/postbox/PostboxFilterRunsOnApplyBadge.vue';
import VacationPage from '../vacation.vue';
import SignaturesPage from '../signatures.vue';
import ForwardingPage from '../forwarding.vue';
import FiltersPage from '../filters.vue';

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
// Synced from the user's provider, so Owlat's MTA never receives its mail.
const CONNECTED = {
	_id: 'mb_gmail',
	address: 'me@gmail.test',
	scope: 'personal',
	kind: 'external',
	status: 'active',
};
const CONNECTED_TEAM = {
	_id: 'mb_team_gmail',
	address: 'team@gmail.test',
	displayName: 'Team Gmail',
	scope: 'shared',
	kind: 'external',
	status: 'active',
};

// The filters the page lists, per mailbox: one built in the editor.
const filterRows = ref<Array<Record<string, unknown>>>([]);
const EDITOR_FILTER = {
	_id: 'f_1',
	name: 'Receipts',
	isEnabled: true,
	stopProcessing: false,
	priority: 0,
	conditions: [{ field: 'from', op: 'contains', value: 'shop' }],
	actions: [{ type: 'addLabel' }],
};

const responders: Record<string, { subject: string } | null> = {
	mb_me: { subject: 'Away from my desk' },
	mb_support: { subject: 'Support is closed this week' },
	mb_sales: null,
	mb_gmail: { subject: 'Saved before the notice' },
};

const forwardingRules: Record<string, Array<Record<string, unknown>>> = {
	mb_me: [
		{
			_id: 'fw_1',
			mailboxId: 'mb_me',
			forwardTo: 'archive@elsewhere.test',
			keepLocalCopy: false,
			isEnabled: true,
		},
	],
	mb_gmail: [
		{
			_id: 'fw_2',
			mailboxId: 'mb_gmail',
			forwardTo: 'desk@elsewhere.test',
			keepLocalCopy: true,
			isEnabled: true,
		},
	],
};

let mailboxes: Array<typeof PERSONAL | typeof SUPPORT | typeof CONNECTED | typeof CONNECTED_TEAM>;
// A ref, so a test can hold the roles read in its loading state and land it.
const roles = ref<Array<{ mailboxId: string; role: 'owner' | 'member' }> | undefined>();
const rolesError = ref<Error | null>(null);
const openMailboxId = ref<string | null>(null);
const route = reactive<{ query: Record<string, string>; hash: string }>({ query: {}, hash: '' });
const navigateTo = vi.fn((to: { query: Record<string, string> }) => {
	route.query = to.query;
});
const sessionState = new Map<string, Ref<unknown>>();
function useState<T>(key: string, init?: () => T): Ref<T> {
	if (!sessionState.has(key)) sessionState.set(key, ref(init?.()));
	return sessionState.get(key) as Ref<T>;
}
const operationRun = vi.fn(async (_args: Record<string, unknown>) => ({ ok: true, result: null }));

function respond(name: string, args: Record<string, unknown>): unknown {
	if (name === getFunctionName(api.mail.mailboxMembers.myRoles)) return roles.value;
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
	if (name === getFunctionName(api.mail.forwarding.list)) {
		return forwardingRules[args['mailboxId'] as string] ?? [];
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
		error: name === getFunctionName(api.mail.mailboxMembers.myRoles) ? rolesError : ref(null),
		refetch: vi.fn(),
	};
}

beforeEach(() => {
	mailboxes = [PERSONAL, SUPPORT, SALES];
	roles.value = [
		{ mailboxId: 'mb_me', role: 'owner' },
		{ mailboxId: 'mb_support', role: 'owner' },
		{ mailboxId: 'mb_sales', role: 'member' },
	];
	rolesError.value = null;
	filterRows.value = [];
	openMailboxId.value = null;
	route.query = {};
	sessionState.clear();
	navigateTo.mockClear();
	vacationReads.mockClear();
	operationRun.mockClear();
	installNuxtStubs({
		...i18nStubs,
		useRoute: () => route,
		useState,
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
		useBackendOperation: () => ({ run: operationRun, isLoading: ref(false) }),
		usePostboxSignatures: () => ({
			signatures: ref([]),
			isLoading: ref(false),
			error: ref(null),
			refetch: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			remove: vi.fn(),
		}),
		usePostboxFilters: () => ({
			filters: filterRows,
			isLoading: ref(false),
			error: ref(null),
			refetch: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			setEnabled: vi.fn(),
			remove: vi.fn(),
			reorder: vi.fn(),
		}),
		usePostboxRules: () => ({
			drafts: ref([]),
			compile: vi.fn(),
			confirm: vi.fn(),
			discard: vi.fn(),
			test: vi.fn(),
			isCompiling: ref(false),
			isTesting: ref(false),
		}),
		usePostboxFolders: () => ({ folders: ref([]) }),
		usePostboxLabels: () => ({ labels: ref([]) }),
		usePostboxSettings: () => ({
			codeAutoArchive: ref(false),
			setCodeAutoArchive: vi.fn(),
			isSaving: ref(false),
			isLoading: ref(false),
		}),
	});
});

function mountPage(page: Component) {
	return mount(page, {
		global: {
			plugins: [createTestI18n()],
			components: {
				PreferencesMailboxPicker,
				PostboxPlainRules,
				PostboxFilterReachNotice,
				PostboxFilterRunsOnApplyBadge,
			},
			stubs: {
				UiInput: {
					props: ['modelValue'],
					emits: ['update:modelValue'],
					template:
						'<input v-bind="$attrs" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
				},
				UiSpinner: true,
				PostboxRuleChips: true,
				PostboxRuleDryRun: true,
				PostboxFilterRuleBuilder: {
					name: 'PostboxFilterRuleBuilder',
					props: ['mailboxId', 'mailbox', 'modelValue'],
					template: '<div />',
				},
				PostboxFilterRunControl: true,
				UiQueryBoundary: { template: '<div><slot /></div>' },
				UiSwitch: true,
				UiSkeleton: true,
				UiConfirmationDialog: true,
				UiBadge: { template: '<span><slot /></span>' },
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
		roles.value = [{ mailboxId: 'mb_me', role: 'owner' }];
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

		// The choice is session state, not a URL a sidebar link could drop.
		expect(navigateTo).not.toHaveBeenCalled();
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

describe('a connected mailbox, where Owlat never receives the mail', () => {
	beforeEach(() => {
		mailboxes = [PERSONAL, CONNECTED];
		roles.value = [
			{ mailboxId: 'mb_me', role: 'owner' },
			{ mailboxId: 'mb_gmail', role: 'owner' },
		];
		openMailboxId.value = 'mb_gmail';
	});

	it('says the vacation reply is set up at the provider and shows no form', async () => {
		const wrapper = mountPage(VacationPage);
		await flushPromises();

		const notice = wrapper.get('[data-testid="connected-mailbox-notice"]');
		expect(notice.text()).toContain('me@gmail.test is synced from your provider');
		expect(notice.text()).toContain('Set the auto-reply up at your provider.');
		// A responder saved earlier never runs, so it must not read as on.
		expect(wrapper.find('#draft-subject').exists()).toBe(false);
		expect(wrapper.text()).not.toContain('Saved before the notice');
		expect(vacationReads).not.toHaveBeenCalledWith({ mailboxId: 'mb_gmail' });
	});

	it('says forwarding is set up at the provider and lists no rule as active', async () => {
		const wrapper = mountPage(ForwardingPage);
		await flushPromises();

		const notice = wrapper.get('[data-testid="connected-mailbox-notice"]');
		expect(notice.text()).toContain('me@gmail.test is synced from your provider');
		expect(wrapper.find('#newaddress').exists()).toBe(false);
		expect(wrapper.text()).not.toContain('desk@elsewhere.test');
	});

	it('shows the form again when the picker moves to the hosted mailbox', async () => {
		const wrapper = mountPage(VacationPage);
		await flushPromises();

		await wrapper.get('select#settings-mailbox').setValue('mb_me');
		await flushPromises();
		expect(wrapper.find('[data-testid="connected-mailbox-notice"]').exists()).toBe(false);
		expect((wrapper.get('#draft-subject').element as HTMLInputElement).value).toBe(
			'Away from my desk'
		);
	});
});

describe('forwarding always keeps the message in the mailbox', () => {
	it('offers no forward-only choice, and a rule saved as one still loads', async () => {
		mailboxes = [PERSONAL];
		roles.value = [{ mailboxId: 'mb_me', role: 'owner' }];
		const wrapper = mountPage(ForwardingPage);
		await flushPromises();

		expect(wrapper.findComponent({ name: 'UiCheckbox' }).exists()).toBe(false);
		expect(wrapper.text()).toContain('archive@elsewhere.test');
		expect(wrapper.text()).not.toContain('Forward only');

		await wrapper.get('#newaddress').setValue('desk@elsewhere.test');
		await wrapper.get('form').trigger('submit');
		await flushPromises();
		expect(operationRun).toHaveBeenCalledWith({
			mailboxId: 'mb_me',
			forwardTo: 'desk@elsewhere.test',
		});
	});
});

describe('signatures name their mailbox too', () => {
	it('offers a team inbox the viewer is only a member of, since members may save signatures', async () => {
		const wrapper = mountPage(SignaturesPage);
		await flushPromises();

		expect(optionValues(wrapper)).toEqual(['mb_me', 'mb_support', 'mb_sales']);
	});
});

describe('a chosen mailbox stays chosen', () => {
	const selectValue = (wrapper: ReturnType<typeof mountPage>) =>
		(wrapper.get('select#settings-mailbox').element as HTMLSelectElement).value;

	it('keeps the forwarding draft on the chosen mailbox when a link drops the query', async () => {
		const wrapper = mountPage(ForwardingPage);
		await flushPromises();
		await wrapper.get('select#settings-mailbox').setValue('mb_support');
		await flushPromises();
		await wrapper.get('#newaddress').setValue('desk@elsewhere.test');

		// The Settings sidebar's Forwarding link, or Back: the same page, no query.
		route.query = {};
		await flushPromises();
		expect(selectValue(wrapper)).toBe('mb_support');

		await wrapper.get('form').trigger('submit');
		await flushPromises();
		expect(operationRun).toHaveBeenCalledWith(
			expect.objectContaining({ mailboxId: 'mb_support', forwardTo: 'desk@elsewhere.test' })
		);
	});

	it('carries the choice to the next settings page', async () => {
		const vacation = mountPage(VacationPage);
		await flushPromises();
		await vacation.get('select#settings-mailbox').setValue('mb_support');
		vacation.unmount();

		const forwarding = mountPage(ForwardingPage);
		await flushPromises();
		expect(selectValue(forwarding)).toBe('mb_support');
	});

	it('does not hand the choice to the next account in the same tab', async () => {
		const vacation = mountPage(VacationPage);
		await flushPromises();
		await vacation.get('select#settings-mailbox').setValue('mb_support');
		vacation.unmount();

		// Signing out does not reload the app, so the session state is still there.
		vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'user2' }) }));
		const forwarding = mountPage(ForwardingPage);
		await flushPromises();
		expect(selectValue(forwarding)).toBe('mb_me');
	});

	it('drops a draft when the mailbox changes under it', async () => {
		openMailboxId.value = 'mb_support';
		const wrapper = mountPage(ForwardingPage);
		await flushPromises();
		await wrapper.get('#newaddress').setValue('desk@elsewhere.test');

		// The roles read updates without the team inbox: the page falls back.
		roles.value = [
			{ mailboxId: 'mb_me', role: 'owner' },
			{ mailboxId: 'mb_sales', role: 'owner' },
		];
		await flushPromises();

		expect(selectValue(wrapper)).toBe('mb_me');
		expect((wrapper.get('#newaddress').element as HTMLInputElement).value).toBe('');
	});
});

describe('the filters page', () => {
	const selectValue = (wrapper: ReturnType<typeof mountPage>) =>
		(wrapper.get('select#settings-mailbox').element as HTMLSelectElement).value;
	const editorOpen = (wrapper: ReturnType<typeof mountPage>) =>
		wrapper.findComponent({ name: 'PostboxFilterRuleBuilder' }).exists();

	it('holds the switch while the plain-language composer has text', async () => {
		const wrapper = mountPage(FiltersPage);
		await flushPromises();
		const select = wrapper.get('select#settings-mailbox');
		expect(select.attributes('disabled')).toBeUndefined();

		await wrapper.get('form input').setValue('archive newsletters after a week');
		expect(select.attributes('disabled')).toBeDefined();

		await wrapper.get('form input').setValue('  ');
		expect(select.attributes('disabled')).toBeUndefined();
	});

	it("opens a message's filter on the mailbox the message is in", async () => {
		route.query = { filterFrom: 'billing@example.com', settingsMailbox: 'mb_support' };
		const wrapper = mountPage(FiltersPage);
		await flushPromises();

		expect(selectValue(wrapper)).toBe('mb_support');
		expect(editorOpen(wrapper)).toBe(true);
		// The deep link is consumed; the mailbox choice outlives it.
		expect(route.query).toEqual({});
	});

	it('waits for the roles read before deciding where the filter goes', async () => {
		roles.value = undefined;
		route.query = { filterFrom: 'billing@example.com', settingsMailbox: 'mb_support' };
		const wrapper = mountPage(FiltersPage);
		await flushPromises();
		expect(editorOpen(wrapper)).toBe(false);

		roles.value = [
			{ mailboxId: 'mb_me', role: 'owner' },
			{ mailboxId: 'mb_support', role: 'owner' },
		];
		await flushPromises();
		expect(selectValue(wrapper)).toBe('mb_support');
		expect(editorOpen(wrapper)).toBe(true);
	});

	it('opens no editor when the message is in a mailbox the viewer may not edit filters for', async () => {
		route.query = { filterFrom: 'billing@example.com', settingsMailbox: 'mb_sales' };
		const wrapper = mountPage(FiltersPage);
		await flushPromises();

		expect(selectValue(wrapper)).toBe('mb_me');
		expect(editorOpen(wrapper)).toBe(false);
	});

	it("keeps a link's mailbox through a failed roles read", async () => {
		const loaded = roles.value;
		roles.value = undefined;
		rolesError.value = new Error('offline');
		route.query = { filterFrom: 'billing@example.com', settingsMailbox: 'mb_support' };
		const wrapper = mountPage(FiltersPage);
		await flushPromises();
		expect(editorOpen(wrapper)).toBe(false);

		// The retry succeeds.
		rolesError.value = null;
		roles.value = loaded;
		await flushPromises();

		expect(selectValue(wrapper)).toBe('mb_support');
		expect(editorOpen(wrapper)).toBe(true);
	});

	it('keeps the earlier choice when a link names a mailbox the page may not edit', async () => {
		const vacation = mountPage(VacationPage);
		await flushPromises();
		await vacation.get('select#settings-mailbox').setValue('mb_support');
		vacation.unmount();

		route.query = { filterFrom: 'billing@example.com', settingsMailbox: 'mb_sales' };
		const wrapper = mountPage(FiltersPage);
		await flushPromises();

		expect(selectValue(wrapper)).toBe('mb_support');
		expect(editorOpen(wrapper)).toBe(false);
	});

	it('still opens the editor from a link that names no mailbox', async () => {
		route.query = { filterFrom: 'billing@example.com' };
		const wrapper = mountPage(FiltersPage);
		await flushPromises();

		expect(editorOpen(wrapper)).toBe(true);
	});
});

describe('filters on a connected mailbox, where synced mail skips the editor filters', () => {
	const notice = (wrapper: ReturnType<typeof mountPage>) =>
		wrapper.find('[data-testid="connected-mailbox-notice"]');
	const rowState = (wrapper: ReturnType<typeof mountPage>) =>
		wrapper.find('[data-testid="filter-runs-on-apply"]');

	beforeEach(() => {
		mailboxes = [PERSONAL, CONNECTED, CONNECTED_TEAM];
		roles.value = [
			{ mailboxId: 'mb_me', role: 'owner' },
			{ mailboxId: 'mb_gmail', role: 'owner' },
			{ mailboxId: 'mb_team_gmail', role: 'owner' },
		];
		filterRows.value = [EDITOR_FILTER];
	});

	it('says the filters do not run on new mail and that plain-language rules still do', async () => {
		openMailboxId.value = 'mb_gmail';
		const wrapper = mountPage(FiltersPage);
		await flushPromises();

		const text = notice(wrapper).text();
		expect(text).toContain('me@gmail.test is synced from your provider');
		expect(text).toContain('do not run on its new mail');
		expect(text).toContain('Run on existing mail');
		expect(text).toContain('Rules in your words still run on new mail');
		// The enabled row says it waits to be applied, so it does not read as working.
		expect(rowState(wrapper).text()).toBe('Runs only when you apply it');
	});

	it('says nothing runs on new mail in a connected team inbox', async () => {
		openMailboxId.value = 'mb_team_gmail';
		const wrapper = mountPage(FiltersPage);
		await flushPromises();

		const text = notice(wrapper).text();
		expect(text).toContain('team@gmail.test is synced from your provider');
		expect(text).toContain('no filter or rule runs on its new mail');
		expect(text).not.toContain('Rules in your words');
		expect(rowState(wrapper).exists()).toBe(true);
	});

	it('marks no row and shows no notice once the picker moves to the hosted mailbox', async () => {
		openMailboxId.value = 'mb_gmail';
		const wrapper = mountPage(FiltersPage);
		await flushPromises();

		await wrapper.get('select#settings-mailbox').setValue('mb_me');
		await flushPromises();
		expect(notice(wrapper).exists()).toBe(false);
		expect(rowState(wrapper).exists()).toBe(false);
	});

	it('says a filter with only forward, delete or discard never runs there', async () => {
		filterRows.value = [
			{ ...EDITOR_FILTER, actions: [{ type: 'forward', forwardTo: 'a@b.test' }] },
		];
		openMailboxId.value = 'mb_gmail';
		const wrapper = mountPage(FiltersPage);
		await flushPromises();

		expect(rowState(wrapper).text()).toBe('Never runs here');
	});

	it('hides the Stop badge, since a run applies one filter at a time', async () => {
		filterRows.value = [{ ...EDITOR_FILTER, stopProcessing: true }];
		openMailboxId.value = 'mb_gmail';
		const wrapper = mountPage(FiltersPage);
		await flushPromises();

		expect(wrapper.text()).not.toContain('Stop');
	});

	it('marks a switched-off filter as off, not as waiting to be applied', async () => {
		filterRows.value = [{ ...EDITOR_FILTER, isEnabled: false }];
		openMailboxId.value = 'mb_gmail';
		const wrapper = mountPage(FiltersPage);
		await flushPromises();

		expect(rowState(wrapper).exists()).toBe(false);
	});

	it("tells the editor it edits a connected mailbox's filter", async () => {
		route.query = { filterFrom: 'billing@example.com', settingsMailbox: 'mb_gmail' };
		const wrapper = mountPage(FiltersPage);
		await flushPromises();

		const editor = wrapper.findComponent({ name: 'PostboxFilterRuleBuilder' });
		expect(editor.props('mailbox')).toMatchObject({ kind: 'external' });
	});
});
