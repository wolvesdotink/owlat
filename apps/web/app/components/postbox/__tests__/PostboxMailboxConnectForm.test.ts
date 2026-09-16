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
// The form renders its copy through vue-i18n; `useI18n` is a Nuxt auto-import.

import PostboxMailboxConnectForm from '../PostboxMailboxConnectForm.vue';
import PostboxGoogleSignIn from '../PostboxGoogleSignIn.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

vi.stubGlobal('useI18n', i18nStubs.useI18n);
import type { MailProvider } from '~/utils/mailAutodiscover';
import type { Id } from '@owlat/api/dataModel';
import { queryResult } from '~/__tests__/queryStubs';
import type { GoogleConnectIntent } from '~/composables/postbox/useGoogleOAuthConnect';
import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';

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

/** Whether `googleOAuth.isConfigured` answers yes for the mounted form. */
let googleConfigured: boolean;
/** Calls the Google branch made: one per "Continue with Google" click. */
let googleConnect: ReturnType<typeof vi.fn>;

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
	googleConfigured = false;
	googleConnect = vi.fn(async () => true);
	vi.stubGlobal('useConvexQuery', () => queryResult({ configured: googleConfigured }));
	vi.stubGlobal('useRoute', () => ({ fullPath: '/dashboard/postbox/migrate' }));
	vi.stubGlobal('useGoogleOAuthConnect', () => ({
		connect: googleConnect,
		isLoading: ref(false),
		handedOffToBrowser: ref(false),
	}));
	vi.stubGlobal(
		'useBackendOperation',
		(_fn: unknown, opts?: { label?: string | (() => string) }) => {
			// Operation labels are getters now (they read the active locale), so the
			// discriminator has to resolve them exactly like the composable does.
			const label = (typeof opts?.label === 'function' ? opts.label() : opts?.label) ?? 'unknown';
			let run = runs.get(label);
			if (!run) {
				run = vi.fn(async () => ({ mailboxId: 'mbx-result' }));
				runs.set(label, run);
			}
			return { run, isLoading: ref(false) };
		}
	);
});

// A guided provider WITH a preset: its server fields auto-fill at setup, so the
// form is submittable after only email + password are entered. `name`/`hint` are
// CATALOG KEYS exactly as the real provider registry stores them — the fixture
// has to keep that shape or it would hide the raw-key label bug below.
const provider: MailProvider = {
	id: 'imap',
	name: 'shared.mailAutodiscover.provider.imap.name',
	icon: 'lucide:server',
	hint: 'shared.mailAutodiscover.provider.imap.hint',
	preset: {
		imapHost: 'imap.test.com',
		imapPort: 993,
		isImapSecure: true,
		smtpHost: 'smtp.test.com',
		smtpPort: 465,
		isSmtpSecure: true,
	},
	appPassword: null,
	oauth: null,
	manualServer: false,
};

/** Gmail, the one provider that can be connected with OAuth. */
const googleProvider: MailProvider = {
	...provider,
	id: 'gmail',
	name: 'shared.mailAutodiscover.provider.gmail.name',
	hint: 'shared.mailAutodiscover.provider.gmail.hint',
	appPassword: {
		provider: 'Gmail',
		url: 'https://myaccount.google.com/apppasswords',
		steps: 'shared.mailAutodiscover.appPassword.gmail',
	},
	oauth: { provider: 'google' },
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

// Renders the `label` prop, not just the control: a field label that paints a
// message key is a user-visible defect, so it has to be in the audited markup.
const UiInputStub = {
	props: ['modelValue', 'type', 'label'],
	emits: ['update:modelValue'],
	template:
		'<label><span>{{ label }}</span><input :type="type" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" /></label>',
};
// Respects `type`: the Google branch's buttons are `type="button"`, and a stub
// that made everything a submit button would fire the password form's submit
// handler on a click that must never reach it.
const UiButtonStub = {
	props: ['type'],
	template: '<button :type="type || \'submit\'"><slot /></button>',
};
const UiErrorAlertStub = { props: ['message'], template: '<div class="err">{{ message }}</div>' };
const iconStub = { props: ['name'], template: '<span />' };

type FormProps = {
	provider?: MailProvider;
	seedProvider?: DestinationProviderKey;
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
			plugins: [createTestI18n()],
			// The Google branch is rendered for real — its copy is the surface these
			// cases are about. The server fields are a stub: they carry no Google
			// behaviour and their disclosure markup is audited in its own suite.
			components: { PostboxGoogleSignIn },
			stubs: {
				PostboxMailboxServerFields: true,
				UiInput: UiInputStub,
				UiButton: UiButtonStub,
				UiErrorAlert: UiErrorAlertStub,
				Icon: iconStub,
				PostboxAppPasswordCallout: true,
				UiDisclosure: { template: '<div><slot name="label" /><slot /></div>' },
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

describe('PostboxMailboxConnectForm provider copy', () => {
	it('translates the provider name into the address label instead of painting its key', () => {
		// `MailProvider.name` is a catalog key. Interpolating it raw put
		// "shared.mailAutodiscover.provider.imap.name address" on the field the user
		// types their email into, on every mount site of this form.
		const wrapper = mountForm({ mode: 'connect' });

		expect(wrapper.text()).toContain('Any IMAP mailbox address');
		expect(wrapper.text()).not.toContain('shared.mailAutodiscover');
		expectFullyLocalized(wrapper);
	});
});

// ── Google sign-in branch ───────────────────────────────────────────────────

/** Click the button whose visible label contains `text`. */
async function clickButton(wrapper: VueWrapper, text: string) {
	const button = wrapper.findAll('button').find((b) => b.text().includes(text));
	expect(button, `no button labelled "${text}"`).toBeDefined();
	await button!.trigger('click');
	await flushPromises();
}

/** The intent the Google branch handed `useGoogleOAuthConnect().connect`. */
function connectedWith(): { intent: GoogleConnectIntent; returnTo: string } {
	expect(googleConnect).toHaveBeenCalledTimes(1);
	const [intent, returnTo] = googleConnect.mock.calls[0] as [GoogleConnectIntent, string];
	return { intent, returnTo };
}

const oauthAccount = { ...account, authMethod: 'oauth2', status: 'active' };

describe('PostboxMailboxConnectForm Google branch', () => {
	it('leads with Google sign-in, and asks for no password, when a client is configured', () => {
		googleConfigured = true;
		const wrapper = mountForm({ provider: googleProvider, mode: 'connect' });

		expect(wrapper.text()).toContain('Continue with Google');
		// The whole point of OAuth here: no password is typed, so none of the
		// password-path surface may render.
		expect(wrapper.find('input[type="password"]').exists()).toBe(false);
		expect(wrapper.find('input[type="email"]').exists()).toBe(false);
		expect(wrapper.text()).not.toContain('Test connection');
		expect(wrapper.findComponent({ name: 'PostboxAppPasswordCallout' }).exists()).toBe(false);
		expectFullyLocalized(wrapper);
	});

	it('renders the app-password form exactly as before when no client is configured', () => {
		googleConfigured = false;
		const wrapper = mountForm({ provider: googleProvider, mode: 'connect' });

		expect(wrapper.text()).not.toContain('Continue with Google');
		expect(wrapper.find('input[type="password"]').exists()).toBe(true);
		expect(wrapper.find('input[type="email"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('Test connection');
	});

	it('hands the whole app-password form back when the user asks for it', async () => {
		// Workspace tenants can block third-party OAuth apps outright, so the
		// password path has to stay reachable even where Google sign-in works.
		googleConfigured = true;
		const wrapper = mountForm({ provider: googleProvider, mode: 'connect' });
		expect(wrapper.find('input[type="password"]').exists()).toBe(false);

		await clickButton(wrapper, 'Use an app password instead');

		expect(wrapper.find('input[type="password"]').exists()).toBe(true);
		expect(wrapper.find('input[type="email"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('Test connection');
		// Nothing was submitted by the toggle itself.
		expect(runFor(CONNECT)!).not.toHaveBeenCalled();
	});

	it('still submits the password path once the form is toggled back on', async () => {
		googleConfigured = true;
		const wrapper = mountForm({ provider: googleProvider, mode: 'connect' });
		await clickButton(wrapper, 'Use an app password instead');

		await fill(wrapper, { email: 'me@gmail.com' });
		await wrapper.find('form').trigger('submit');
		await flushPromises();

		expect(runFor(CONNECT)!).toHaveBeenCalledTimes(1);
		expect(googleConnect).not.toHaveBeenCalled();
	});

	it('offers a re-authorization, and the password escape hatch, for an OAuth account', async () => {
		googleConfigured = true;
		const wrapper = mountForm({
			provider: googleProvider,
			mode: 'update',
			account: oauthAccount,
		});

		expect(wrapper.text()).toContain('Reconnect with Google');
		expect(wrapper.text()).toContain('Use an app password instead');

		await clickButton(wrapper, 'Reconnect with Google');
		expect(connectedWith().intent).toEqual({ kind: 'update' });
	});

	it('says "Continue", not "Reconnect", when the account still uses a password', () => {
		googleConfigured = true;
		const wrapper = mountForm({ provider: googleProvider, mode: 'update', account });

		expect(wrapper.text()).toContain('Continue with Google');
		expect(wrapper.text()).not.toContain('Reconnect with Google');
	});

	it('flags the return path so the wizard can start the import on the way back', async () => {
		googleConfigured = true;
		const wrapper = mountForm({ provider: googleProvider, mode: 'connect' });

		await clickButton(wrapper, 'Continue with Google');

		expect(connectedWith().returnTo).toBe('/dashboard/postbox/migrate?googleConnected=1');
	});

	// The same five-way fan-out `handleSubmit` dispatches on. A wrong intent here
	// is the OAuth twin of the bug the submit-dispatch suite guards: the exchange
	// would connect a team inbox as the caller's personal mailbox, or rewrite a
	// personal account from a team-inbox form.
	const intentCases: { name: string; props: FormProps; intent: GoogleConnectIntent }[] = [
		{ name: 'personal connect', props: { mode: 'connect' }, intent: { kind: 'connect' } },
		{
			name: 'personal update',
			props: { mode: 'update', account: oauthAccount },
			intent: { kind: 'update' },
		},
		{
			name: 'team inbox connect',
			props: { mode: 'connect', shared: true, displayName: 'Support', memberUserIds: ['u1'] },
			intent: { kind: 'connectShared', displayName: 'Support', memberUserIds: ['u1'] },
		},
		{
			name: 'team inbox update',
			props: {
				mode: 'update',
				shared: true,
				mailboxId: 'mbx-42' as Id<'mailboxes'>,
				account: oauthAccount,
			},
			intent: { kind: 'updateShared', mailboxId: 'mbx-42' as Id<'mailboxes'> },
		},
		{
			name: 'deliverability seed connect',
			props: { mode: 'connect', seedProvider: 'gmail' },
			intent: { kind: 'connectSeed', seedProvider: 'gmail' },
		},
	];

	it.each(intentCases)('maps the $name mount to its connect intent', async ({ props, intent }) => {
		googleConfigured = true;
		const wrapper = mountForm({ provider: googleProvider, ...props });

		await clickButton(wrapper, 'with Google');

		expect(connectedWith().intent).toEqual(intent);
	});

	it('refuses a team-inbox re-authorization that lost its mailbox', async () => {
		googleConfigured = true;
		const wrapper = mountForm({
			provider: googleProvider,
			mode: 'update',
			shared: true,
			account: oauthAccount,
		});

		await clickButton(wrapper, 'with Google');

		// Never fall through to the personal account — the same trap the submit
		// path guards, reached through the OAuth door.
		expect(googleConnect).not.toHaveBeenCalled();
		expect(wrapper.text()).toContain('its mailbox is missing');
	});
});
