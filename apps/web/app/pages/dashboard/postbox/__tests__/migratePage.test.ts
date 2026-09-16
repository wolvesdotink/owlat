// @vitest-environment happy-dom
/**
 * The migrate wizard's "returning from Google sign-in" hand-off.
 *
 * The OAuth flow takes the browser away from this page, so the connect form's
 * `submitted` event never fires — the wizard restarts the import itself when it
 * comes back with `googleConnected=1`. Two timings have to work: the account
 * subscription already resolved at mount (client-side nav / warm cache) and
 * resolving a tick later (cold load). The first of those used to throw
 * `ReferenceError: Cannot access 'stop' before initialization`, because the
 * `immediate: true` watcher called its own not-yet-assigned stop handle — so
 * the import never started on exactly the fast path.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { type VueWrapper } from '@vue/test-utils';
import { nextTick, ref, computed } from 'vue';

import { i18nStubs } from '~/__tests__/i18n';
import { mountDashboardPage } from '~/__tests__/a11y';
import MigratePage from '../migrate.vue';

type Account = { configured: boolean; imapHost?: string; mailboxId?: string; status?: string };

const connectedAccount: Account = {
	configured: true,
	imapHost: 'imap.gmail.com',
	mailboxId: 'mailbox-1',
	status: 'ok',
};

const start = vi.fn(async () => ({ ok: true as const, result: null }));
const cancel = vi.fn(async () => ({ ok: true as const, result: null }));
const showToast = vi.fn();
const replace = vi.fn();
const account = ref<Account | null>(null);
const migration = ref<{ status: string } | null>(null);
const query = ref<Record<string, string>>({});

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useHead: () => {},
		definePageMeta: () => {},
		useRoute: () => ({
			get query() {
				return query.value;
			},
		}),
		useRouter: () => ({ replace }),
		useToast: () => ({ showToast }),
		useFeatureFlag: () => ({ isEnabled: () => true, isLoading: ref(false) }),
		useConvexQuery: () => ({ data: ref(null), isLoading: ref(false) }),
		useBackendOperation: () => ({
			run: vi.fn(async () => ({ ok: true, result: null })),
			isLoading: ref(false),
		}),
		useMailMigration: () => ({
			migration,
			account,
			step: computed(() => (account.value?.configured ? 'ready' : 'connect')),
			importPercent: computed(() => 0),
			indexPercent: computed(() => 0),
			isAiIndexing: computed(() => false),
			isDiscovering: computed(() => false),
			start,
			cancel,
			startBusy: ref(false),
			cancelBusy: ref(false),
		}),
	});
});

let wrapper: VueWrapper | null = null;

beforeEach(() => {
	vi.clearAllMocks();
	account.value = null;
	migration.value = null;
	query.value = { googleConnected: '1' };
});

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

function mountPage(): VueWrapper {
	// The wizard's children carry their own suites; stubbing them keeps this one
	// about the page's own return-from-OAuth logic (and keeps the warn guard
	// happy about unresolved names).
	wrapper = mountDashboardPage(MigratePage, {
		stubs: {
			PreferencesBackLink: true,
			UiStepIndicator: true,
			UiProgressBar: true,
			UiConfirmationDialog: true,
			PostboxMailboxConnectForm: true,
			PostboxArchiveImportCard: true,
		},
	});
	return wrapper;
}

describe('migrate wizard — returning from Google sign-in', () => {
	it('starts the import once when the account is already resolved at mount', async () => {
		account.value = connectedAccount;
		mountPage();
		await nextTick();

		expect(start).toHaveBeenCalledTimes(1);
		expect(start).toHaveBeenCalledWith('google');
		expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Import'), 'success');
	});

	it('strips the googleConnected flag from the URL', async () => {
		account.value = connectedAccount;
		query.value = { googleConnected: '1', from: 'onboarding' };
		mountPage();
		await nextTick();

		expect(replace).toHaveBeenCalledWith({ query: { from: 'onboarding' } });
	});

	it('waits for a later-resolving account subscription, then starts once', async () => {
		mountPage();
		await nextTick();
		expect(start).not.toHaveBeenCalled();

		account.value = connectedAccount;
		await nextTick();

		expect(start).toHaveBeenCalledTimes(1);
		expect(start).toHaveBeenCalledWith('google');
	});

	it('never starts twice as the subscriptions keep updating', async () => {
		account.value = connectedAccount;
		mountPage();
		await nextTick();

		account.value = { ...connectedAccount, status: 'idle' };
		await nextTick();
		migration.value = { status: 'importing' };
		await nextTick();

		expect(start).toHaveBeenCalledTimes(1);
	});

	it('does nothing without the flag', async () => {
		query.value = {};
		account.value = connectedAccount;
		mountPage();
		await nextTick();

		expect(start).not.toHaveBeenCalled();
		expect(replace).not.toHaveBeenCalled();
	});

	it('skips the start when an import is already running', async () => {
		account.value = connectedAccount;
		migration.value = { status: 'importing' };
		mountPage();
		await nextTick();

		expect(start).not.toHaveBeenCalled();
		expect(replace).toHaveBeenCalled();
	});
});
