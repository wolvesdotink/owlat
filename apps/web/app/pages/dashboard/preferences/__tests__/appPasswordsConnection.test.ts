/**
 * The connection settings on the App passwords page name the instance's own
 * mail server. The host comes from the backend; with none configured the page
 * sends the user to their admin instead of making one up from the browser's
 * address.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { api } from '@owlat/api';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import AppPasswordsPage from '../app-passwords.vue';

const connection = ref<{ mailHost: string | null } | undefined>();
const connectionError = ref<Error | null>(null);

function useConvexQuery(fn: FunctionReference<'query'>) {
	const isConnection =
		getFunctionName(fn) === getFunctionName(api.mail.appPasswords.clientConnection);
	return {
		data: computed(() => (isConnection ? connection.value : undefined)),
		isLoading: computed(() => isConnection && connection.value === undefined),
		error: isConnection ? connectionError : ref(null),
		refetch: vi.fn(),
	};
}

beforeEach(() => {
	connection.value = undefined;
	connectionError.value = null;
	installNuxtStubs({
		...i18nStubs,
		useConvexQuery,
		usePostboxSettingsMailbox: () => ({
			mailboxes: ref([{ _id: 'mb_me', address: 'me@owlat.test', scope: 'personal' }]),
			currentMailbox: ref({ _id: 'mb_me', address: 'me@owlat.test', scope: 'personal' }),
			mailboxId: ref('mb_me'),
			selectMailbox: vi.fn(),
			isLoading: ref(false),
			error: ref(null),
			refetch: vi.fn(),
		}),
		usePostboxAppPasswords: () => ({
			passwords: ref([]),
			isLoading: ref(false),
			error: ref(null),
			refetch: vi.fn(),
			generate: vi.fn(),
			revoke: vi.fn(),
		}),
	});
});

async function mountPage() {
	const wrapper = mount(AppPasswordsPage, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				PreferencesMailboxPicker: true,
				PostboxAppPasswordReveal: true,
				UiConfirmationDialog: true,
				UiModal: true,
				UiQueryBoundary: true,
				UiBadge: true,
				UiCheckbox: true,
				UiButton: { template: '<button><slot /></button>' },
			},
		},
	});
	await flushPromises();
	return wrapper;
}

describe('app passwords: connection settings', () => {
	it('shows the configured mail host for IMAP and SMTP', async () => {
		connection.value = { mailHost: 'mail.example.com' };
		const text = (await mountPage()).text();

		expect(text).toContain('mail.example.com:993 (TLS)');
		expect(text).toContain('mail.example.com:465 (TLS) / 587 (STARTTLS)');
		expect(text).not.toContain('owlat.app');
		expect(text).not.toContain('Ask your admin for the mail server address.');
	});

	it('sends the user to their admin when the instance has no mail host', async () => {
		connection.value = { mailHost: null };
		const text = (await mountPage()).text();

		expect(text).toContain('Ask your admin for the mail server address.');
		expect(text).not.toContain('owlat.app');
		expect(text).not.toContain(':993');
	});

	it('does not guess a host while the read is failing', async () => {
		connectionError.value = new Error('offline');
		const text = (await mountPage()).text();

		expect(text).toContain('Ask your admin for the mail server address.');
		expect(text).not.toContain('owlat.app');
	});
});
