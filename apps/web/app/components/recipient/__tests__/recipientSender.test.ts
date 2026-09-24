// @vitest-environment happy-dom
/**
 * Recipient pages name the sender, not Owlat (#798). Someone unsubscribing
 * from Northwind Studio's newsletter has never heard of Owlat; a page headed
 * "Owlat" looks like phishing. And when the link is broken, the page still
 * offers a way out: the sender's address.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import UnsubscribePage from '~/pages/unsubscribe.vue';
import PreferencesPage from '~/pages/preferences.vue';
import ConfirmPage from '~/pages/confirm.vue';
import RecipientHeader from '../RecipientHeader.vue';
import RecipientFooter from '../RecipientFooter.vue';
import RecipientContactHint from '../RecipientContactHint.vue';
import WorkspaceLogo from '~/components/workspace/WorkspaceLogo.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useRecipientSender } from '~/composables/useRecipientSender';

let sender: { name: string | null; contactEmail: string | null; logoUrl?: string | null } | Error =
	{
		name: 'Northwind Studio',
		contactEmail: 'hello@northwind.example',
	};
const query = vi.fn(async () => {
	if (sender instanceof Error) throw sender;
	return sender;
});

beforeEach(() => {
	sender = { name: 'Northwind Studio', contactEmail: 'hello@northwind.example' };
	query.mockClear();
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useRecipientSender,
	});
	vi.stubGlobal('useSeoMeta', vi.fn());
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	// No token: every page lands in its error state without a network call.
	vi.stubGlobal('useRoute', () => ({ query: {} }));
	vi.stubGlobal('useRuntimeConfig', () => ({ public: { convexSiteUrl: 'https://api.test' } }));
	vi.stubGlobal('useConvex', () => ({ query, mutation: vi.fn() }));
});

function mountPage(page: object) {
	return mount(page, {
		global: {
			plugins: [createTestI18n()],
			components: { RecipientHeader, RecipientFooter, RecipientContactHint, WorkspaceLogo },
			stubs: { UiSpinner: true, UiButton: true, UiSwitch: true, Icon: true },
		},
	});
}

describe('recipient pages lead with the sender', () => {
	it.each([
		['unsubscribe', UnsubscribePage, 'Email preferences'],
		['preferences', PreferencesPage, 'Email preferences'],
		['confirm', ConfirmPage, 'Email confirmation'],
	])('%s heads the page with the sender name', async (_name, page, purpose) => {
		const w = mountPage(page);
		await flushPromises();

		expect(w.find('h1').text()).toBe('Northwind Studio');
		expect(w.find('header').text()).toContain(purpose);
		// Owlat is only the small footer credit.
		expect(w.find('h1').text()).not.toContain('Owlat');
		expect(w.text()).toContain('Powered by Owlat');
	});

	it.each([
		['unsubscribe', UnsubscribePage],
		['preferences', PreferencesPage],
		['confirm', ConfirmPage],
	])('%s shows the workspace logo above the sender name (#810)', async (_name, page) => {
		sender = {
			name: 'Northwind Studio',
			contactEmail: null,
			logoUrl: 'https://files.owlat.test/logo.png',
		};
		const w = mountPage(page);
		await flushPromises();
		const img = w.find('header [data-testid="workspace-logo"] img');
		expect(img.attributes('src')).toBe('https://files.owlat.test/logo.png');
		expect(w.find('h1').text()).toBe('Northwind Studio');
	});

	it('shows no logo when none is set', async () => {
		const w = mountPage(UnsubscribePage);
		await flushPromises();
		expect(w.find('[data-testid="workspace-logo"]').exists()).toBe(false);
	});

	it('falls back to what the page is for, never to "Owlat"', async () => {
		sender = { name: null, contactEmail: null };
		const w = mountPage(UnsubscribePage);
		await flushPromises();
		expect(w.find('h1').text()).toBe('Email preferences');
	});

	it('survives a failed sender lookup with the same fallback', async () => {
		sender = new Error('offline');
		const w = mountPage(UnsubscribePage);
		await flushPromises();
		expect(w.find('h1').text()).toBe('Email preferences');
	});
});

describe('a broken link still leaves a way out', () => {
	it.each([
		['unsubscribe', UnsubscribePage, 'To stop these emails, you can also write to'],
		['preferences', PreferencesPage, 'To stop these emails, you can also write to'],
		['confirm', ConfirmPage, 'Questions? Write to'],
	])('%s shows the sender address in its error state', async (_name, page, lead) => {
		const w = mountPage(page);
		await flushPromises();

		expect(w.text()).toContain(lead);
		const link = w.find('a[href="mailto:hello@northwind.example"]');
		expect(link.exists()).toBe(true);
		expect(link.text()).toBe('hello@northwind.example');
	});

	it('says nothing extra when no address is configured', async () => {
		sender = { name: 'Northwind Studio', contactEmail: null };
		const w = mountPage(UnsubscribePage);
		await flushPromises();
		expect(w.find('a[href^="mailto:"]').exists()).toBe(false);
		expect(w.text()).toContain('Unable to unsubscribe');
	});
});

describe('RecipientHeader', () => {
	it('keeps an unbounded sender name inside a 320px card', () => {
		const w = mount(RecipientHeader, { props: { name: 'N'.repeat(80), purpose: 'x' } });
		expect(w.find('h1').classes()).toContain('break-words');
	});
});
