// @vitest-environment happy-dom
/**
 * Files, Subscriptions, the message route and the folder index mount the real
 * `PostboxMailboxGuard`, so a member without a mailbox gets the guard's next
 * step instead of a page-local empty state.
 *
 * These pages once hand-rolled their own: Files and Subscriptions offered
 * "Add mail account" even while a hosted mailbox was reserved or external
 * accounts were off, the message route showed a bare sentence (and nothing at
 * all while loading), and the folder index forced the guard into its
 * no-mailbox branch with a literal null.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { VueWrapper } from '@vue/test-utils';
import { defineComponent, h, reactive, ref, type Component } from 'vue';

import { i18nStubs } from '~/__tests__/i18n';
import { mountDashboardPage } from '~/__tests__/a11y';
import PostboxMailboxGuard from '~/components/postbox/PostboxMailboxGuard.vue';
import FilesPage from '../files.vue';
import SubscriptionsPage from '../subscriptions.vue';
import FolderIndexPage from '../[folder]/index.vue';
import MessagePage from '../[folder]/[messageId].vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const currentMailbox = ref<{ _id: string } | null>(null);
const mailboxesLoading = ref(false);
const mailboxError = ref<Error | null>(null);
const reservedAddress = ref<string | null>(null);
const externalAllowed = ref(false);
const route = reactive({ params: { folder: 'inbox', messageId: 'msg-1' } });

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useHead: () => {},
		definePageMeta: () => {},
		useRoute: () => route,
		useAuth: () => ({ user: ref({ id: 'user-1' }) }),
		usePostboxMailbox: () => ({
			currentMailbox,
			isLoading: mailboxesLoading,
			error: mailboxError,
		}),
		// The guard's only query: the self-scoped fresh-start status.
		useConvexQuery: () => ({
			data: ref({
				hasMailbox: false,
				reservedAddress: reservedAddress.value,
				reservationAwaitingDomain: false,
				hasOpenRequest: false,
			}),
			isLoading: ref(false),
		}),
		useFeatureFlag: () => ({
			isEnabled: (flag: string) => flag === 'mail.external' && externalAllowed.value,
		}),
		useBackendOperation: () => ({ run: vi.fn(), isLoading: ref(false) }),
	});
});

/** Renders its name as a test id and its props as attributes. */
const marker = (name: string) =>
	defineComponent({
		name,
		inheritAttrs: false,
		setup:
			(_p, { attrs, slots }) =>
			() =>
				h('div', { 'data-testid': name, ...attrs }, slots.default?.()),
	});

const buttonStub = defineComponent({
	name: 'UiButton',
	props: { to: { type: String, default: undefined } },
	setup:
		(props, { slots }) =>
		() =>
			h('a', { href: props.to }, slots.default?.()),
});

let wrapper: VueWrapper | null = null;

function mountPage(page: Component) {
	wrapper = mountDashboardPage(page, {
		components: {
			PostboxMailboxGuard,
			UiButton: buttonStub,
			I18nT: marker('I18nT'),
			PostboxFilesPanel: marker('PostboxFilesPanel'),
			PostboxSubscriptionsPanel: marker('PostboxSubscriptionsPanel'),
			PostboxLayout: marker('PostboxLayout'),
			PostboxComposerStack: marker('PostboxComposerStack'),
			DashboardGettingStarted: marker('DashboardGettingStarted'),
			UiErrorAlert: marker('UiErrorAlert'),
		},
	});
	return wrapper;
}

beforeEach(() => {
	currentMailbox.value = null;
	mailboxesLoading.value = false;
	mailboxError.value = null;
	reservedAddress.value = null;
	externalAllowed.value = false;
});

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

const pages: Array<[string, Component, string]> = [
	['files', FilesPage, 'PostboxFilesPanel'],
	['subscriptions', SubscriptionsPage, 'PostboxSubscriptionsPanel'],
	['folder index', FolderIndexPage, 'PostboxLayout'],
	['message route', MessagePage, 'PostboxLayout'],
];

const byTestId = (w: VueWrapper, id: string) => w.find(`[data-testid="${id}"]`).exists();

describe.each(pages)('the %s page', (_name, page, content) => {
	it('renders its content for the resolved mailbox', () => {
		currentMailbox.value = { _id: 'mailbox-1' };
		const w = mountPage(page);
		expect(w.get(`[data-testid="${content}"]`).attributes('mailbox-id')).toBe('mailbox-1');
	});

	it("shows the guard's spinner while the mailbox resolves", () => {
		mailboxesLoading.value = true;
		const w = mountPage(page);
		expect(w.find('[aria-label="Loading mailbox"]').exists()).toBe(true);
		expect(byTestId(w, content)).toBe(false);
	});

	it('tells a member with a reserved mailbox to wait, not to add an account', () => {
		reservedAddress.value = 'member@owlat.test';
		externalAllowed.value = true;
		const w = mountPage(page);
		expect(byTestId(w, 'mailbox-guard-reserved')).toBe(true);
		expect(w.find('a[href="/dashboard/preferences/add-account"]').exists()).toBe(false);
	});

	it('offers to connect an account only when external accounts are allowed', () => {
		externalAllowed.value = true;
		const w = mountPage(page);
		expect(byTestId(w, 'mailbox-guard-external')).toBe(true);
		expect(w.find('a[href="/dashboard/preferences/add-account"]').exists()).toBe(true);
	});

	it('falls back to asking an admin', () => {
		const w = mountPage(page);
		expect(byTestId(w, 'mailbox-guard-deadend')).toBe(true);
		expect(w.find('a[href="/dashboard/preferences/add-account"]').exists()).toBe(false);
	});
});

describe('the folder index page', () => {
	it('keeps the onboarding checklist below the no-mailbox state', () => {
		const w = mountPage(FolderIndexPage);
		expect(byTestId(w, 'mailbox-guard-deadend')).toBe(true);
		expect(byTestId(w, 'DashboardGettingStarted')).toBe(true);
	});

	it('hides the checklist while loading and once a mailbox exists', async () => {
		mailboxesLoading.value = true;
		const w = mountPage(FolderIndexPage);
		expect(byTestId(w, 'DashboardGettingStarted')).toBe(false);

		mailboxesLoading.value = false;
		currentMailbox.value = { _id: 'mailbox-1' };
		await w.vm.$nextTick();
		expect(byTestId(w, 'DashboardGettingStarted')).toBe(false);
		expect(byTestId(w, 'PostboxLayout')).toBe(true);
	});

	it('shows a failed mailbox query as an error, not as "no mailbox"', () => {
		mailboxError.value = new Error('boom');
		const w = mountPage(FolderIndexPage);
		expect(byTestId(w, 'UiErrorAlert')).toBe(true);
		expect(byTestId(w, 'mailbox-guard-deadend')).toBe(false);
	});
});
