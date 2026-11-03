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
import PostboxOAuthSignIn from '../PostboxOAuthSignIn.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import { tooltipOf } from '~/__tests__/tooltip';

vi.stubGlobal('useI18n', i18nStubs.useI18n);
import type { MailProvider } from '~/utils/mailAutodiscover';
import type { Id } from '@owlat/api/dataModel';
import { queryResult } from '~/__tests__/queryStubs';
import type { MailOAuthIntent } from '~/composables/postbox/useMailOAuthConnect';
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
/** Calls the sign-in branch made: one per "Sign in with …" click. */
let googleConnect: ReturnType<typeof vi.fn>;

const CONNECT = 'Connect mailbox';
const CONNECT_SHARED = 'Connect team inbox';
const UPDATE = 'Update mail credentials';
const UPDATE_SHARED = 'Update team inbox credentials';
const TEST = 'Test mail connection';

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
	vi.stubGlobal('useMailOAuthConnect', () => ({
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
			components: { PostboxOAuthSignIn },
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

describe('PostboxMailboxConnectForm Test connection', () => {
	const testButton = (wrapper: VueWrapper) =>
		wrapper.findAll('button').find((button) => button.text() === 'Test connection')!;

	it('stays reachable without a password, says why in a tooltip, and tests nothing', async () => {
		const wrapper = mountForm({ mode: 'connect' });
		const button = testButton(wrapper);
		expect(button.attributes('title')).toBeUndefined();
		expect(button.attributes('disabled')).toBeUndefined();
		expect(button.attributes('aria-disabled')).toBe('true');
		expect(tooltipOf(wrapper, button)).toBe('Enter the password to test the connection');
		await button.trigger('click');
		await flushPromises();
		expect(runFor(TEST)).not.toHaveBeenCalled();
	});

	it('runs the test once the password is in, with no tooltip left to explain', async () => {
		const wrapper = mountForm({ mode: 'connect' });
		await fill(wrapper);
		const button = testButton(wrapper);
		expect(button.attributes('aria-disabled')).toBeUndefined();
		expect(tooltipOf(wrapper, button)).toBeUndefined();
		await button.trigger('click');
		await flushPromises();
		expect(runFor(TEST)).toHaveBeenCalledTimes(1);
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

/** What the sign-in branch handed `useMailOAuthConnect().connect`. */
function connectedWith(): { provider: string; intent: MailOAuthIntent; returnTo: string } {
	expect(googleConnect).toHaveBeenCalledTimes(1);
	const [provider, intent, returnTo] = googleConnect.mock.calls[0] as [
		string,
		MailOAuthIntent,
		string,
	];
	return { provider, intent, returnTo };
}

const oauthAccount = { ...account, authMethod: 'oauth2', status: 'active' };

/**
 * The rendered order of the two paths: which one the user meets first. Compared
 * in DOM order rather than by searching the markup, so the component's own
 * comments can never be mistaken for its copy.
 */
function googleComesBeforePassword(wrapper: VueWrapper): boolean {
	const google = wrapper.findComponent(PostboxOAuthSignIn);
	expect(google.exists(), 'no Google block rendered').toBe(true);
	const password = wrapper.find('input[type="password"]').element;
	// DOCUMENT_POSITION_FOLLOWING: the password field comes after the block.
	return (google.element.compareDocumentPosition(password) & 4) !== 0;
}

describe('PostboxMailboxConnectForm Google branch', () => {
	it('keeps the app-password form whole, and adds Google under it, when a client is configured', () => {
		googleConfigured = true;
		const wrapper = mountForm({ provider: googleProvider, mode: 'connect' });

		// Google sign-in is an EXTRA. Configuring an OAuth client is work only an
		// admin can do, so it must never cost the path every Gmail user can take:
		// the password form renders whole, and first.
		expect(wrapper.find('input[type="password"]').exists()).toBe(true);
		expect(wrapper.find('input[type="email"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('Test connection');
		expect(wrapper.findComponent({ name: 'PostboxAppPasswordCallout' }).exists()).toBe(true);

		expect(wrapper.text()).toContain('Sign in with Google');
		expect(googleComesBeforePassword(wrapper)).toBe(false);
		expectFullyLocalized(wrapper);
	});

	it('renders the app-password form exactly as before when no client is configured', () => {
		googleConfigured = false;
		const wrapper = mountForm({ provider: googleProvider, mode: 'connect' });

		expect(wrapper.text()).not.toContain('with Google');
		expect(wrapper.find('input[type="password"]').exists()).toBe(true);
		expect(wrapper.find('input[type="email"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('Test connection');
		expect(wrapper.findComponent({ name: 'PostboxAppPasswordCallout' }).exists()).toBe(true);
	});

	it('submits the password path even where Google sign-in is on offer', async () => {
		googleConfigured = true;
		const wrapper = mountForm({ provider: googleProvider, mode: 'connect' });

		await fill(wrapper, { email: 'me@gmail.com' });
		await wrapper.find('form').trigger('submit');
		await flushPromises();

		expect(runFor(CONNECT)!).toHaveBeenCalledTimes(1);
		expect(googleConnect).not.toHaveBeenCalled();
	});

	it('leads with the re-authorization, password form still below, for an OAuth account', async () => {
		googleConfigured = true;
		const wrapper = mountForm({
			provider: googleProvider,
			mode: 'update',
			account: oauthAccount,
		});

		// The one mount where Google leads: there is no password on this account to
		// re-enter, so reconnecting is what the user came for. Rotating it onto an
		// app password stays available underneath.
		expect(wrapper.text()).toContain('Reconnect with Google');
		expect(googleComesBeforePassword(wrapper)).toBe(true);
		expect(wrapper.find('input[type="password"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('Test connection');
		expectFullyLocalized(wrapper);

		await clickButton(wrapper, 'Reconnect with Google');
		expect(connectedWith().intent).toEqual({ kind: 'update' });
	});

	it('does not lead with Google, or say "Reconnect", when the account uses a password', () => {
		googleConfigured = true;
		const wrapper = mountForm({ provider: googleProvider, mode: 'update', account });

		expect(wrapper.text()).toContain('Sign in with Google');
		expect(wrapper.text()).not.toContain('Reconnect with Google');
		expect(googleComesBeforePassword(wrapper)).toBe(false);
	});

	it('flags the return path so the wizard can start the import on the way back', async () => {
		googleConfigured = true;
		const wrapper = mountForm({ provider: googleProvider, mode: 'connect' });

		await clickButton(wrapper, 'with Google');

		expect(connectedWith().returnTo).toBe('/dashboard/postbox/migrate?oauthConnected=1');
	});

	// The same five-way fan-out `handleSubmit` dispatches on. A wrong intent here
	// is the OAuth twin of the bug the submit-dispatch suite guards: the exchange
	// would connect a team inbox as the caller's personal mailbox, or rewrite a
	// personal account from a team-inbox form.
	const intentCases: { name: string; props: FormProps; intent: MailOAuthIntent }[] = [
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

// ── Microsoft sign-in branch ────────────────────────────────────────────────

/** Outlook.com / Microsoft 365, connected with Microsoft sign-in. */
const outlookProvider: MailProvider = {
	...provider,
	id: 'outlook',
	name: 'shared.mailAutodiscover.provider.outlook.name',
	hint: 'shared.mailAutodiscover.provider.outlook.hint',
	oauth: { provider: 'microsoft' },
};

/** The generic IMAP card: no provider of its own, servers typed by hand. */
const genericProvider: MailProvider = { ...provider, preset: null, manualServer: true };

describe('PostboxMailboxConnectForm Microsoft branch', () => {
	it('offers Microsoft sign-in under the password form on the Outlook card', async () => {
		googleConfigured = true;
		const wrapper = mountForm({ provider: outlookProvider, mode: 'connect' });

		expect(wrapper.text()).toContain('Sign in with Microsoft');
		expect(wrapper.text()).not.toContain('with Google');
		expect(googleComesBeforePassword(wrapper)).toBe(false);
		expectFullyLocalized(wrapper);

		await clickButton(wrapper, 'with Microsoft');
		expect(connectedWith()).toEqual({
			provider: 'microsoft',
			intent: { kind: 'connect' },
			returnTo: '/dashboard/postbox/migrate?oauthConnected=1',
		});
	});

	it('leaves the Outlook card password-only when no Microsoft app is configured', () => {
		googleConfigured = false;
		const wrapper = mountForm({ provider: outlookProvider, mode: 'connect' });

		expect(wrapper.text()).not.toContain('with Microsoft');
		expect(wrapper.find('input[type="password"]').exists()).toBe(true);
	});

	it('reconnects a Microsoft account with Microsoft, whatever card it maps to', async () => {
		googleConfigured = true;
		const wrapper = mountForm({
			provider: genericProvider,
			mode: 'update',
			account: { ...oauthAccount, oauthProvider: 'microsoft' },
		});

		expect(wrapper.text()).toContain('Reconnect with Microsoft');
		expect(googleComesBeforePassword(wrapper)).toBe(true);
		await clickButton(wrapper, 'Reconnect with Microsoft');
		expect(connectedWith().provider).toBe('microsoft');
	});

	const DETECT = 'Check whether Microsoft hosts this address';

	it('offers Microsoft sign-in on the generic card when the backend says Microsoft hosts the address', async () => {
		vi.useFakeTimers();
		try {
			googleConfigured = true;
			const detect = vi.fn(async ({ email }: { email: string }) => ({
				ok: true,
				result: { hosted: email.endsWith('@contoso.com') },
			}));
			runs.set(DETECT, detect);
			const wrapper = mountForm({ provider: genericProvider, mode: 'connect' });
			expect(wrapper.text()).not.toContain('with Microsoft');

			await wrapper.find('input[type="email"]').setValue('ada@contoso.com');
			await vi.advanceTimersByTimeAsync(500);
			await flushPromises();

			expect(detect).toHaveBeenCalledWith({ email: 'ada@contoso.com' });
			expect(wrapper.text()).toContain('Sign in with Microsoft');
			expect(wrapper.text()).toContain('Microsoft hosts the mail for this address');
			expectFullyLocalized(wrapper);

			// Typing on hides the offer at once; a domain Microsoft does not host
			// never brings it back.
			await wrapper.find('input[type="email"]').setValue('ada@example.org');
			expect(wrapper.text()).not.toContain('with Microsoft');
			await vi.advanceTimersByTimeAsync(500);
			await flushPromises();
			expect(wrapper.text()).not.toContain('with Microsoft');
		} finally {
			vi.useRealTimers();
		}
	});

	it('asks nothing for a guided card or an incomplete address', async () => {
		vi.useFakeTimers();
		try {
			const detect = vi.fn();
			runs.set(DETECT, detect);
			const guided = mountForm({ provider: outlookProvider, mode: 'connect' });
			await guided.find('input[type="email"]').setValue('ada@contoso.com');
			const generic = mountForm({ provider: genericProvider, mode: 'connect' });
			await generic.find('input[type="email"]').setValue('ada@contoso');
			await vi.advanceTimersByTimeAsync(500);

			expect(detect).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
