/**
 * The account page, end to end through its cards: the display name and its
 * leave guard, the login-email and password requests, the data export, and
 * account deletion with its pending state. These cases drive each card and
 * assert on what reaches the auth client and the backend.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { installNuxtStubs, queryResult } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { formatDate } from '~/utils/formatters';

const auth = vi.hoisted(() => ({
	updateUser: vi.fn(async () => ({ error: null })),
	changeEmail: vi.fn(async () => ({ error: null })),
	changePassword: vi.fn(async () => ({ error: null })),
}));
vi.mock('~/lib/auth-client', () => ({ authClient: auth }));

const exporter = vi.hoisted(() => ({
	write: vi.fn(async (_convex: unknown, _userId: string, _sink: unknown, onRow: () => void) => {
		onRow();
		onRow();
	}),
	open: vi.fn(async () => ({ sink: true })),
}));
vi.mock('~/utils/accountJsonExport', () => ({ writeAccountJsonExport: exporter.write }));
vi.mock('~/utils/incrementalJsonDownload', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	openIncrementalJsonDownload: exporter.open,
}));

import AccountPage from '../account.vue';

const NOW = Date.parse('2026-08-21T09:12:00Z');
const DAY = 86_400_000;

const pendingDeletion = ref<unknown>(null);
const role = ref('owner');
const ops: Record<string, ReturnType<typeof vi.fn>> = {};
const showToast = vi.fn();
const setHasChanges = vi.fn();
const convex = {
	action: vi.fn(async () => ({ sections: [] })),
	query: vi.fn(async () => ({
		contacts: [{ email: 'ada@owlat.example', firstName: '=HYPERLINK("x")' }],
		properties: ['plan'],
	})),
};

const FieldStub = defineComponent({
	props: ['modelValue', 'id', 'label', 'type'],
	emits: ['update:modelValue'],
	template:
		'<input :id="id" :type="type || \'text\'" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
});
const ModalStub = defineComponent({
	props: { open: { type: Boolean, default: false } },
	emits: ['update:open'],
	template:
		'<section v-if="open" role="dialog"><slot /><footer><slot name="footer" /></footer></section>',
});

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
	pendingDeletion.value = null;
	role.value = 'owner';
	for (const key of Object.keys(ops)) delete ops[key];
	for (const fn of [
		showToast,
		setHasChanges,
		convex.action,
		convex.query,
		exporter.write,
		exporter.open,
	])
		fn.mockClear();
	for (const fn of Object.values(auth)) fn.mockClear();
	installNuxtStubs({
		...i18nStubs,
		useToast: () => ({ showToast }),
		useConvex: () => convex,
		useOrganizationContext: () => ({ hasActiveOrganization: ref(true), role }),
		useConvexQuery: () => ({ ...queryResult(undefined), data: pendingDeletion }),
		useBackendOperation: (_fn: unknown, options: { label: () => string }) => {
			const label = options.label();
			const run = vi.fn(async () => ({ ok: true, result: undefined }));
			ops[label] = run;
			return { run, isLoading: ref(false) };
		},
		useUnsavedChanges: () => ({
			showDialog: ref(false),
			isSavingBeforeLeave: ref(false),
			confirmDiscard: vi.fn(),
			confirmSave: vi.fn(),
			cancelNavigation: vi.fn(),
			setHasChanges,
		}),
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function mountPage() {
	return mount(AccountPage, {
		global: {
			plugins: [createTestI18n()],
			// Template auto-imports; the test build does not rewrite templates.
			mocks: { formatDate },
			stubs: {
				UiIconBox: true,
				UiButton: { template: '<button v-bind="$attrs"><slot /></button>', inheritAttrs: false },
				UiInput: FieldStub,
				AuthPasswordInput: FieldStub,
				UiModal: ModalStub,
				UiQueryBoundary: true,
				UiSkeleton: true,
				UiSkeletonText: true,
				UiUnsavedChangesDialog: true,
				PostboxDailyBriefSettings: true,
				PreferencesYourData: true,
				PreferencesExportManifest: {
					props: ['rows', 'isLoading', 'isExporting', 'rowsWritten', 'percent'],
					template: '<p class="manifest">rows written: {{ rowsWritten }}</p>',
				},
				I18nT: {
					props: ['keypath'],
					template:
						'<p :data-keypath="keypath"><slot name="email" /><slot name="date" /><slot name="word" /><slot name="warning" /></p>',
				},
				NuxtLink: { template: '<a><slot /></a>' },
			},
		},
	});
}

const button = (wrapper: ReturnType<typeof mountPage>, label: string) =>
	wrapper.findAll('button').filter((b) => b.text().trim() === label);

describe('account page', () => {
	it('saves the display name and feeds its dirty state into the leave guard', async () => {
		const wrapper = mountPage();
		const name = wrapper.get('#profile-name');
		expect((name.element as HTMLInputElement).value).toBe('Ada Lovelace');
		expect(setHasChanges).toHaveBeenLastCalledWith(false);

		await name.setValue('Ada King');
		expect(setHasChanges).toHaveBeenLastCalledWith(true);
		await button(wrapper, 'Save')[0]!.trigger('click');
		await flushPromises();
		expect(auth.updateUser).toHaveBeenCalledWith({ name: 'Ada King' });
		expect(showToast).toHaveBeenLastCalledWith('Profile updated');
		expect(setHasChanges).toHaveBeenLastCalledWith(false);
		wrapper.unmount();
	});

	it('requests a login-email change only for a new, valid address', async () => {
		const wrapper = mountPage();
		const email = wrapper.get('#new-email');
		const form = email.element.closest('form')!;

		await email.setValue('not-an-address');
		form.dispatchEvent(new Event('submit'));
		expect(showToast).toHaveBeenLastCalledWith('Enter a valid email address', 'error');
		await email.setValue('ADA@example.com');
		form.dispatchEvent(new Event('submit'));
		expect(showToast).toHaveBeenLastCalledWith('That is already your login email', 'error');
		expect(auth.changeEmail).not.toHaveBeenCalled();

		await email.setValue('New@Owlat.example');
		form.dispatchEvent(new Event('submit'));
		await flushPromises();
		expect(auth.changeEmail).toHaveBeenCalledWith({
			newEmail: 'new@owlat.example',
			callbackURL: '/dashboard/preferences/account',
		});
		expect(showToast).toHaveBeenLastCalledWith('Check your inbox to confirm the change');
		// An unverified account gets the link at the new address.
		const sent = wrapper.get(
			'[data-keypath="dashboard.preferences.account.confirmationSentFinish"]'
		);
		expect(sent.text()).toBe('new@owlat.example');
		expect((wrapper.get('#new-email').element as HTMLInputElement).value).toBe('');
		wrapper.unmount();
	});

	it('checks the new password before changing it, then clears the fields', async () => {
		const wrapper = mountPage();
		const form = wrapper.get('#cur-pw').element.closest('form')!;
		await wrapper.get('#cur-pw').setValue('old-secret-123');
		await wrapper.get('#new-pw').setValue('short');
		form.dispatchEvent(new Event('submit'));
		expect(showToast).toHaveBeenLastCalledWith(
			'New password must be at least 12 characters',
			'error'
		);

		await wrapper.get('#new-pw').setValue('a-long-new-secret');
		await wrapper.get('#confirm-pw').setValue('a-different-secret');
		form.dispatchEvent(new Event('submit'));
		expect(showToast).toHaveBeenLastCalledWith('New passwords do not match', 'error');
		expect(auth.changePassword).not.toHaveBeenCalled();

		await wrapper.get('#confirm-pw').setValue('a-long-new-secret');
		form.dispatchEvent(new Event('submit'));
		await flushPromises();
		expect(auth.changePassword).toHaveBeenCalledWith({
			currentPassword: 'old-secret-123',
			newPassword: 'a-long-new-secret',
		});
		expect(showToast).toHaveBeenLastCalledWith('Password changed');
		for (const id of ['#cur-pw', '#new-pw', '#confirm-pw'])
			expect((wrapper.get(id).element as HTMLInputElement).value).toBe('');
		wrapper.unmount();
	});

	it('reads the export plan, then exports JSON and a sanitised contacts CSV', async () => {
		const createObjectURL = vi.fn((_blob: Blob) => 'blob:contacts');
		vi.spyOn(URL, 'createObjectURL').mockImplementation(createObjectURL);
		vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
		vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

		const wrapper = mountPage();
		await flushPromises();
		expect(convex.action).toHaveBeenCalledWith(expect.anything(), { userId: 'user1' });

		await button(wrapper, 'Export JSON')[0]!.trigger('click');
		await flushPromises();
		expect(exporter.open).toHaveBeenCalledWith('owlat-data-export-2026-08-21.json');
		expect(exporter.write).toHaveBeenCalledWith(
			convex,
			'user1',
			{ sink: true },
			expect.any(Function)
		);
		expect(wrapper.get('.manifest').text()).toBe('rows written: 2');
		expect(showToast).toHaveBeenLastCalledWith('Data exported successfully');

		await button(wrapper, 'Export CSV')[0]!.trigger('click');
		await flushPromises();
		expect(convex.query).toHaveBeenCalledWith(expect.anything(), {});
		const csv = await createObjectURL.mock.calls[0]![0].text();
		expect(csv.split('\r\n')[0]).toBe(
			'email,firstName,lastName,source,timezone,createdAt,updatedAt,topics,plan'
		);
		expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
		expect(showToast).toHaveBeenLastCalledWith('Contacts exported successfully');
		wrapper.unmount();
	});

	it('requests deletion only once DELETE is typed', async () => {
		const wrapper = mountPage();
		expect(wrapper.text()).toContain('All teams you own and their data');
		expect(wrapper.text()).not.toContain('belongs to the team');

		await button(wrapper, 'Request account deletion')[0]!.trigger('click');
		const confirm = () => button(wrapper, 'Delete my account')[0]!;
		expect(confirm().attributes('disabled')).toBeDefined();
		await wrapper.get('#delete-reason').setValue('Moving on');
		await wrapper.get('#confirm-delete').setValue('DELETE');
		expect(confirm().attributes('disabled')).toBeUndefined();
		await confirm().trigger('click');
		await flushPromises();
		expect(ops['Request account deletion']).toHaveBeenCalledWith({
			userId: 'user1',
			reason: 'Moving on',
		});
		expect(showToast).toHaveBeenLastCalledWith(
			'Account deletion request submitted. Check your email for confirmation.'
		);
		expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
		wrapper.unmount();
	});

	it('lists only personal data for a member', () => {
		role.value = 'editor';
		const wrapper = mountPage();
		expect(wrapper.text()).toContain('Your personal mailbox, mail, and drafts');
		expect(wrapper.text()).not.toContain('All teams you own and their data');
		expect(wrapper.text()).toContain('belongs to the team');
		wrapper.unmount();
	});

	it('shows a pending deletion with its countdown and cancels it', async () => {
		pendingDeletion.value = { scheduledForDeletion: NOW + 12 * DAY - 3_600_000 };
		const wrapper = mountPage();
		expect(wrapper.text()).toContain('Account deletion pending');
		expect(wrapper.text()).toContain('12 days remaining');
		expect(wrapper.text()).not.toContain('Request account deletion');

		await button(wrapper, 'Cancel account deletion')[0]!.trigger('click');
		await flushPromises();
		expect(ops['Cancel account deletion']).toHaveBeenCalledWith({ userId: 'user1' });
		expect(showToast).toHaveBeenLastCalledWith('Account deletion cancelled successfully');
		wrapper.unmount();
	});
});
