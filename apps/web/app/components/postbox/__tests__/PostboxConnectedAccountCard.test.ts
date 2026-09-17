// @vitest-environment happy-dom
/**
 * The connected-mailbox card — the screen that finally lets someone end a
 * connection, rather than the wizard branch where the buttons used to live.
 *
 * What is pinned here is what a member is owed at each of the three states:
 * a live connection they can change the password on, disconnect, or delete; a
 * disconnected mailbox that still holds their mail (reconnect, or delete it);
 * and nothing connected at all. Plus the two things that make the destructive
 * pair safe — neither mutation runs until the dialog is confirmed, and the
 * disconnect confirmation tells the truth about a running import instead of
 * letting it die quietly.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref, computed, watch, type Ref } from 'vue';

import PostboxConnectedAccountCard from '../PostboxConnectedAccountCard.vue';
import { createTestI18n, i18nStubs, expectFullyLocalized } from '~/__tests__/i18n';

// Each `api.a.b.c` is its own readable path, so the two subscriptions this card
// opens can be told apart in the query stub.
vi.mock('@owlat/api', () => {
	const pathProxy = (path: string): unknown =>
		new Proxy(function () {}, {
			get: (_target, key) =>
				key === '__path' ? path : pathProxy(path === '' ? String(key) : `${path}.${String(key)}`),
		});
	return { api: pathProxy('') };
});

type Account = {
	configured: true;
	emailAddress: string;
	imapHost: string;
	imapPort: number;
	isImapSecure: boolean;
	smtpHost: string;
	smtpPort: number;
	isSmtpSecure: boolean;
	imapUsername: string;
	status: string;
	lastError?: string;
	lastSyncAt?: number;
};
type Retained = {
	configured: false;
	retained?: {
		emailAddress: string;
		imapHost: string;
		imapUsername: string;
		disconnectedAt: number;
	};
};

const CONNECTED: Account = {
	configured: true,
	emailAddress: 'me@example.com',
	imapHost: 'imap.example.com',
	imapPort: 993,
	isImapSecure: true,
	smtpHost: 'smtp.example.com',
	smtpPort: 465,
	isSmtpSecure: true,
	imapUsername: 'me@example.com',
	status: 'connected',
	lastSyncAt: Date.UTC(2026, 8, 17, 9, 30),
};

const accountData: Ref<Account | Retained | null> = ref(null);
const migrationData: Ref<{ status: string } | null> = ref(null);
const accountLoading = ref(false);
const accountQueryError: Ref<Error | null> = ref(null);
const flagOn = ref(true);
const disconnectRun = vi.fn(async () => ({ ok: true }));
const purgeRun = vi.fn(async () => ({ ok: true }));
const toasts: string[] = [];
const navigateTo = vi.fn();
/** Per-query args factories, keyed by the api path the card subscribed with. */
const subscriptionArgs = new Map<string, () => unknown>();
/** Which page the card is rendered on — Settings unless a test says otherwise. */
const routePath = ref('/dashboard/preferences/external-account');

beforeAll(() => {
	vi.stubGlobal('useConvexQuery', (reference: { __path: string }, args: () => unknown) => {
		// Keep the args factory: whether a subscription is opened at all ('skip' or
		// not) is behaviour, and a stub that drops it cannot see it.
		subscriptionArgs.set(reference.__path, args);
		if (reference.__path.includes('migration')) {
			return { data: migrationData, isLoading: ref(false), error: ref(null) };
		}
		return { data: accountData, isLoading: accountLoading, error: accountQueryError };
	});
	vi.stubGlobal('useBackendOperation', (reference: { __path: string }) => ({
		run: reference.__path.includes('purge') ? purgeRun : disconnectRun,
		isLoading: ref(false),
		inlineError: ref(null),
	}));
	vi.stubGlobal('useFeatureFlag', () => ({
		isEnabled: (name: string) => name === 'mail.external' && flagOn.value,
	}));
	vi.stubGlobal('useToast', () => ({
		showToast: (message: string) => {
			toasts.push(message);
		},
	}));
	vi.stubGlobal('navigateTo', navigateTo);
	vi.stubGlobal('useRoute', () => ({ path: routePath.value }));
	vi.stubGlobal('watch', watch);
	vi.stubGlobal('computed', computed);
	vi.stubGlobal('ref', ref);
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

beforeEach(() => {
	flagOn.value = true;
	accountLoading.value = false;
	accountQueryError.value = null;
	accountData.value = { ...CONNECTED };
	migrationData.value = null;
	routePath.value = '/dashboard/preferences/external-account';
	subscriptionArgs.clear();
	navigateTo.mockClear();
	disconnectRun.mockClear();
	purgeRun.mockClear();
	toasts.length = 0;
});

const iconStub = { props: ['name'], template: '<span />' };
const buttonStub = {
	props: ['size', 'variant', 'disabled', 'loading'],
	template: '<button v-bind="$attrs"><slot /></button>',
};
/** Stands in for UiConfirmationDialog: renders its copy, emits its two events. */
const confirmStub = {
	props: ['open', 'title', 'description', 'confirmText', 'variant', 'isLoading'],
	emits: ['confirm', 'cancel', 'update:open'],
	template: `<div v-if="open" class="dialog">
		<p class="dialog-title">{{ title }}</p>
		<p class="dialog-description">{{ description }}</p>
		<button class="dialog-confirm" @click="$emit('confirm')">{{ confirmText }}</button>
		<button class="dialog-cancel" @click="$emit('cancel')">cancel</button>
	</div>`,
};
const connectFormStub = {
	props: ['provider', 'mode', 'account', 'hideCancel'],
	template: '<form class="connect-form" />',
};

const mountCard = (props: Record<string, unknown> = {}) =>
	mount(PostboxConnectedAccountCard, {
		props,
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: iconStub,
				UiButton: buttonStub,
				UiConfirmationDialog: confirmStub,
				PostboxMailboxConnectForm: connectFormStub,
			},
		},
	});

describe('PostboxConnectedAccountCard — a live connection', () => {
	it('names the mailbox, how it is doing, and every way out of it', () => {
		const wrapper = mountCard();
		expect(wrapper.find('[data-testid="connected-account-address"]').text()).toBe('me@example.com');
		expect(wrapper.find('[data-testid="connected-account-status"]').text()).toBe('Syncing');
		expect(wrapper.find('[data-testid="connected-account-disconnect"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="connected-account-delete"]').exists()).toBe(true);
		expectFullyLocalized(wrapper);
	});

	it('says what is wrong in the provider’s own words when the connection breaks', () => {
		accountData.value = {
			...CONNECTED,
			status: 'auth_error',
			lastError: 'Invalid credentials (Failure)',
		};
		const wrapper = mountCard();
		expect(wrapper.find('[data-testid="connected-account-status"]').text()).toBe(
			'Needs reconnecting'
		);
		expect(wrapper.text()).toContain('Invalid credentials (Failure)');
	});

	it('opens the credential form in place rather than sending the member elsewhere', async () => {
		const wrapper = mountCard();
		expect(wrapper.find('.connect-form').exists()).toBe(false);
		await wrapper
			.findAll('button')
			.find((b) => b.text() === 'Update password')!
			.trigger('click');
		expect(wrapper.find('.connect-form').exists()).toBe(true);
	});
});

describe('PostboxConnectedAccountCard — the destructive pair', () => {
	it('disconnects only after the dialog is confirmed', async () => {
		const wrapper = mountCard();
		expect(disconnectRun).not.toHaveBeenCalled();

		await wrapper.find('[data-testid="connected-account-disconnect"]').trigger('click');
		expect(disconnectRun).not.toHaveBeenCalled();
		expect(wrapper.find('.dialog-title').text()).toBe('Disconnect this mailbox?');

		await wrapper.find('.dialog-confirm').trigger('click');
		await flushPromises();
		expect(disconnectRun).toHaveBeenCalledTimes(1);
		expect(purgeRun).not.toHaveBeenCalled();
		expect(toasts).toEqual(['Mailbox disconnected.']);
	});

	it('says nothing reassuring when the server refuses', async () => {
		disconnectRun.mockResolvedValueOnce({ ok: false });
		const wrapper = mountCard();
		await wrapper.find('[data-testid="connected-account-disconnect"]').trigger('click');
		await wrapper.find('.dialog-confirm').trigger('click');
		await flushPromises();
		expect(toasts).toEqual([]);
		expect(wrapper.find('.dialog').exists()).toBe(false);
	});

	it('runs nothing when the dialog is dismissed', async () => {
		const wrapper = mountCard();
		await wrapper.find('[data-testid="connected-account-delete"]').trigger('click');
		await wrapper.find('.dialog-cancel').trigger('click');
		await flushPromises();
		expect(purgeRun).not.toHaveBeenCalled();
		expect(wrapper.find('.dialog').exists()).toBe(false);
	});

	it('warns that a running import will stop, and only then', async () => {
		const wrapper = mountCard();
		await wrapper.find('[data-testid="connected-account-disconnect"]').trigger('click');
		expect(wrapper.find('.dialog-description').text()).not.toContain('import');

		migrationData.value = { status: 'importing' };
		await flushPromises();
		expect(wrapper.find('.dialog-description').text()).toContain('import still running will stop');
	});

	it('warns that deleting erases the mail here and nothing at the provider', async () => {
		const wrapper = mountCard();
		await wrapper.find('[data-testid="connected-account-delete"]').trigger('click');
		const description = wrapper.find('.dialog-description').text();
		expect(description).toContain('Mail at your provider is untouched');
		expect(description).toContain('cannot be undone');

		await wrapper.find('.dialog-confirm').trigger('click');
		await flushPromises();
		expect(purgeRun).toHaveBeenCalledTimes(1);
	});
});

describe('PostboxConnectedAccountCard — after a disconnect', () => {
	beforeEach(() => {
		accountData.value = {
			configured: false,
			retained: {
				emailAddress: 'me@example.com',
				imapHost: 'imap.example.com',
				imapUsername: 'me@example.com',
				disconnectedAt: Date.UTC(2026, 8, 16, 12, 0),
			},
		};
	});

	it('offers the kept mail back, or gone for good — and nothing to disconnect', () => {
		const wrapper = mountCard();
		const retained = wrapper.find('[data-testid="connected-account-retained"]');
		expect(retained.exists()).toBe(true);
		expect(retained.text()).toContain('me@example.com');
		expect(retained.text()).toContain('Connect it again');
		expect(wrapper.find('[data-testid="connected-account-disconnect"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="connected-account-delete"]').exists()).toBe(true);
		expectFullyLocalized(wrapper);
	});

	it('deletes the kept mail on confirmation', async () => {
		const wrapper = mountCard();
		await wrapper.find('[data-testid="connected-account-delete"]').trigger('click');
		await wrapper.find('.dialog-confirm').trigger('click');
		await flushPromises();
		expect(purgeRun).toHaveBeenCalledTimes(1);
	});
});

describe('PostboxConnectedAccountCard — nothing connected', () => {
	beforeEach(() => {
		accountData.value = { configured: false };
	});

	it('points at the wizard on a settings page', () => {
		const wrapper = mountCard();
		expect(wrapper.text()).toContain('Connect a mailbox');
		expectFullyLocalized(wrapper);
	});

	it('stays out of the way where the wizard is already on screen', () => {
		const wrapper = mountCard({ showEmptyState: false });
		expect(wrapper.find('[data-testid="connected-account-card"]').exists()).toBe(false);
	});

	it('self-hides on an instance with the feature turned off', () => {
		flagOn.value = false;
		accountData.value = null;
		expect(mountCard().find('[data-testid="connected-account-card"]').exists()).toBe(false);
	});
});

describe('PostboxConnectedAccountCard — states that are not the happy path', () => {
	it('says the read failed rather than claiming nothing is connected', () => {
		accountQueryError.value = new Error('subscription timed out');
		accountData.value = null;
		const wrapper = mountCard();
		expect(wrapper.text()).toContain('could not load your connected mailbox');
		expect(wrapper.text()).not.toContain('Connect a mailbox');
	});

	it('reports the delete as running, not as mail it kept for you', async () => {
		const wrapper = mountCard();
		await wrapper.find('[data-testid="connected-account-delete"]').trigger('click');
		await wrapper.find('.dialog-confirm').trigger('click');
		await flushPromises();

		// The cascade deletes in scheduled chunks, so the account still reads back
		// as a disconnected one holding mail for as long as it runs.
		accountData.value = {
			configured: false,
			retained: {
				emailAddress: 'me@example.com',
				imapHost: 'imap.example.com',
				imapUsername: 'me@example.com',
				disconnectedAt: Date.now(),
			},
		};
		await flushPromises();
		expect(wrapper.find('[data-testid="connected-account-deleting"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="connected-account-retained"]').exists()).toBe(false);

		// …and stands down once the rows are actually gone.
		accountData.value = { configured: false };
		await flushPromises();
		expect(wrapper.find('[data-testid="connected-account-deleting"]').exists()).toBe(false);
	});

	it('describes deleting the kept mail without promising to forget a password twice', async () => {
		accountData.value = {
			configured: false,
			retained: {
				emailAddress: 'me@example.com',
				imapHost: 'imap.example.com',
				imapUsername: 'me@example.com',
				disconnectedAt: Date.now(),
			},
		};
		const wrapper = mountCard();
		await wrapper.find('[data-testid="connected-account-delete"]').trigger('click');
		const description = wrapper.find('.dialog-description').text();
		expect(description).toContain('Mail at your provider is untouched');
		expect(description).not.toContain('saved password');
	});

	it('leaves the password form to the wizard when the wizard is showing one', () => {
		const wrapper = mountCard({ showCredentialUpdate: false });
		expect(wrapper.text()).not.toContain('Update password');
		expect(wrapper.find('[data-testid="connected-account-disconnect"]').exists()).toBe(true);
	});

	it('scrolls to the connect form instead of navigating to the page it is on', async () => {
		const scrollTo = vi.fn();
		vi.stubGlobal('scrollTo', scrollTo);
		routePath.value = '/dashboard/postbox/migrate';
		accountData.value = {
			configured: false,
			retained: {
				emailAddress: 'me@example.com',
				imapHost: 'imap.example.com',
				imapUsername: 'me@example.com',
				disconnectedAt: Date.now(),
			},
		};
		const wrapper = mountCard();
		await wrapper
			.findAll('button')
			.find((b) => b.text() === 'Connect it again')!
			.trigger('click');
		expect(navigateTo).not.toHaveBeenCalled();
		expect(scrollTo).toHaveBeenCalled();
	});
});

describe('PostboxConnectedAccountCard — what it subscribes to', () => {
	/** The args factory for the one subscription whose path matches. */
	const argsFor = (fragment: string) =>
		[...subscriptionArgs.entries()].find(([path]) => path.includes(fragment))?.[1];

	it('asks the backend nothing on an instance with the feature turned off', () => {
		flagOn.value = false;
		mountCard();
		expect(argsFor('getForCurrentUser')?.()).toBe('skip');
		expect(argsFor('migration')?.()).toBe('skip');
	});

	it('only watches the import while there is a connection to interrupt', async () => {
		accountData.value = { configured: false };
		mountCard();
		expect(argsFor('getForCurrentUser')?.()).toEqual({});
		expect(argsFor('migration')?.()).toBe('skip');

		accountData.value = { ...CONNECTED };
		await flushPromises();
		expect(argsFor('migration')?.()).toEqual({});
	});
});
