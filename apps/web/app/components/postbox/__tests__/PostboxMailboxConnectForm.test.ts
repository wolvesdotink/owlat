// @vitest-environment happy-dom
/**
 * PostboxMailboxConnectForm submit dispatch — the (mode × shared) fan-out in
 * handleSubmit. The failure mode a wrong branch would cause is exactly the one
 * the component's inline comment warns about: silently rewriting the caller's
 * PERSONAL external account with a team inbox's servers/password. These tests
 * pin each of the four branches (plus the missing-mailboxId guard) so that
 * dispatch can't regress unnoticed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { ref, onBeforeUnmount } from 'vue';

// The shared test setup polyfills most Nuxt-auto-imported Vue APIs, but not
// `onBeforeUnmount` (the form uses it to clear its autodiscover timer).
vi.stubGlobal('onBeforeUnmount', onBeforeUnmount);

import PostboxMailboxConnectForm from '../PostboxMailboxConnectForm.vue';
import type { MailProvider } from '~/utils/mailAutodiscover';
import type { Id } from '@owlat/api/dataModel';

// `api` is a bottomless Proxy — every path is the same value, so the operation
// each call site targets can't be told apart by identity. We discriminate on the
// `label` passed to useBackendOperation instead (below).
vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const CONNECT = 'Connect mailbox';
const CONNECT_SHARED = 'Connect team inbox';
const UPDATE = 'Update mail credentials';
const UPDATE_SHARED = 'Update team inbox credentials';

// One distinct run mock per backend operation, keyed on its label.
let runs: Map<string, ReturnType<typeof vi.fn>>;
function runFor(label: string) {
	return runs.get(label);
}

beforeEach(() => {
	runs = new Map();
	vi.stubGlobal('useBackendOperation', (_fn: unknown, opts?: { label?: string }) => {
		const label = opts?.label ?? 'unknown';
		let run = runs.get(label);
		if (!run) {
			run = vi.fn(async () => ({ mailboxId: 'mbx-result' }));
			runs.set(label, run);
		}
		return { run, isLoading: ref(false) };
	});
});

// A guided provider WITH a preset: its server fields auto-fill at setup, so the
// form is submittable after only email + password are entered.
const provider: MailProvider = {
	id: 'imap',
	name: 'Test Mail',
	icon: 'lucide:server',
	hint: 'test',
	preset: {
		imapHost: 'imap.test.com',
		imapPort: 993,
		isImapSecure: true,
		smtpHost: 'smtp.test.com',
		smtpPort: 465,
		isSmtpSecure: true,
	},
	appPassword: null,
	manualServer: false,
};

const account = {
	emailAddress: 'support@team.com',
	imapHost: 'imap.test.com',
	imapPort: 993,
	isImapSecure: true,
	smtpHost: 'smtp.test.com',
	smtpPort: 465,
	isSmtpSecure: true,
	imapUsername: 'support@team.com',
	status: 'auth_error',
};

const UiInputStub = {
	props: ['modelValue', 'type', 'label'],
	emits: ['update:modelValue'],
	template:
		'<input :type="type" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};
const UiButtonStub = { template: '<button type="submit"><slot /></button>' };
const UiErrorAlertStub = { props: ['message'], template: '<div class="err">{{ message }}</div>' };
const iconStub = { props: ['name'], template: '<span />' };

type FormProps = {
	mode: 'connect' | 'update';
	shared?: boolean;
	displayName?: string;
	memberUserIds?: string[];
	mailboxId?: Id<'mailboxes'>;
	account?: typeof account | null;
};

function mountForm(props: FormProps) {
	return mount(PostboxMailboxConnectForm, {
		props: { provider, ...props },
		global: {
			stubs: {
				UiInput: UiInputStub,
				UiButton: UiButtonStub,
				UiErrorAlert: UiErrorAlertStub,
				Icon: iconStub,
				PostboxAppPasswordCallout: true,
			},
		},
	});
}

async function fill(wrapper: VueWrapper, opts: { email?: string } = {}) {
	if (opts.email) await wrapper.find('input[type="email"]').setValue(opts.email);
	await wrapper.find('input[type="password"]').setValue('app-password-123');
}

describe('PostboxMailboxConnectForm submit dispatch', () => {
	it('connect + shared routes to connectShared with the roster, not the personal connect', async () => {
		const wrapper = mountForm({
			mode: 'connect',
			shared: true,
			displayName: 'Support',
			memberUserIds: ['u1', 'u2'],
		});
		await fill(wrapper, { email: 'support@team.com' });
		await wrapper.find('form').trigger('submit');
		await flushPromises();

		expect(runFor(CONNECT_SHARED)).toBeDefined();
		expect(runFor(CONNECT_SHARED)!).toHaveBeenCalledTimes(1);
		expect(runFor(CONNECT_SHARED)!.mock.calls[0]![0]).toMatchObject({
			displayName: 'Support',
			memberUserIds: ['u1', 'u2'],
		});
		expect(runFor(CONNECT)).not.toHaveBeenCalled();
	});

	it('update + shared routes to updateCredentialsShared keyed by mailboxId', async () => {
		const wrapper = mountForm({
			mode: 'update',
			shared: true,
			mailboxId: 'mbx-42' as Id<'mailboxes'>,
			account,
		});
		await fill(wrapper);
		await wrapper.find('form').trigger('submit');
		await flushPromises();

		expect(runFor(UPDATE_SHARED)).toBeDefined();
		expect(runFor(UPDATE_SHARED)!).toHaveBeenCalledTimes(1);
		expect(runFor(UPDATE_SHARED)!.mock.calls[0]![0]).toMatchObject({ mailboxId: 'mbx-42' });
		expect(runFor(UPDATE)).not.toHaveBeenCalled();
	});

	it('update + shared without a mailboxId errors and never falls through to the personal update', async () => {
		const wrapper = mountForm({ mode: 'update', shared: true, account });
		await fill(wrapper);
		await wrapper.find('form').trigger('submit');
		await flushPromises();

		// The guard must fire — no personal (or shared) credential write happens.
		expect(runFor(UPDATE)).not.toHaveBeenCalled();
		expect(runFor(UPDATE_SHARED)).not.toHaveBeenCalled();
		expect(wrapper.text()).toContain('its mailbox is missing');
	});

	it('connect without shared routes to the personal connect', async () => {
		const wrapper = mountForm({ mode: 'connect' });
		await fill(wrapper, { email: 'me@example.com' });
		await wrapper.find('form').trigger('submit');
		await flushPromises();

		expect(runFor(CONNECT)).toBeDefined();
		expect(runFor(CONNECT)!).toHaveBeenCalledTimes(1);
		expect(runFor(CONNECT_SHARED)).not.toHaveBeenCalled();
	});
});
