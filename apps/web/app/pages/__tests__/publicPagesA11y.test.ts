// @vitest-environment happy-dom
/**
 * ACCESSIBILITY PASS ON THE RECIPIENT-FACING PAGES.
 *
 * These are the only Owlat pages a stranger ever loads, they are reached from a
 * link in an email, and there is no support channel behind them: if the
 * unsubscribe confirmation is a nameless button or the preference switches have
 * no label, the recipient's only remaining option is marking the mail as spam.
 * They are also the cheapest pages to audit — each one is a token, one fetch and
 * a state machine — so the whole file is a single axe pass per page.
 *
 * EACH PAGE IS AUDITED IN ITS LOADED STATE, not its spinner: the token fetch is
 * answered from a stub keyed by the endpoint the page calls, so the mount that
 * axe sees is the one the recipient reads.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { auditA11y, installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { interpretShareResponse } from '~/utils/shareLinkResponse';
import UnsubscribePage from '../unsubscribe.vue';
import PreferencesPage from '../preferences.vue';
import ConfirmPage from '../confirm.vue';
import ArchivePage from '../archive.vue';
import SharePage from '../share.vue';
import CancelDeletionPage from '../cancel-deletion.vue';
import ImprintPage from '../imprint.vue';
import TermsPage from '../terms.vue';

const contact = {
	email: 'ada@example.com',
	firstName: 'Ada',
	subscribed: true,
	organizationName: 'Analytical Engines',
	teamName: 'Analytical Engines',
	topics: [
		{ _id: 'topic1', name: 'Product news', description: 'Releases and changes', subscribed: true },
		{ _id: 'topic2', name: 'Events', subscribed: false },
	],
};

/** Answers the recipient endpoints by path; anything else is a hard failure. */
function stubRecipientFetch(): void {
	const byPath: Record<string, unknown> = {
		'/unsub/verify/': { ok: true, data: contact },
		'/prefs/verify/': { ok: true, data: contact },
		'/archive/': {
			ok: true,
			data: {
				html: '<h2>This month at Analytical Engines</h2><p>Hello Ada.</p>',
				subject: 'This month at Analytical Engines',
				sentAt: Date.UTC(2026, 0, 14),
				organizationName: 'Analytical Engines',
			},
		},
		'/share/': {
			ok: true,
			data: {
				html: '<h2>Shared campaign</h2><p>Hello Ada.</p>',
				subject: 'Shared campaign',
				organizationName: 'Analytical Engines',
				expiresAt: Date.UTC(2026, 1, 14),
			},
		},
	};
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string) => {
			const body = Object.entries(byPath).find(([path]) => url.includes(path))?.[1];
			if (body === undefined) throw new Error(`unstubbed recipient fetch: ${url}`);
			return { ok: true, status: 200, json: async () => body };
		})
	);
}

beforeEach(() => {
	installNuxtStubs({
		...i18nStubs,
		useRoute: () => ({ path: '/', fullPath: '/', query: { token: 'tok' }, params: {}, meta: {} }),
		// The confirm page reads its submission straight off the Convex client.
		useConvex: () => ({
			query: vi.fn(async () => ({
				email: contact.email,
				organizationName: contact.organizationName,
				status: 'pending',
			})),
			mutation: vi.fn(async () => ({ ok: true })),
		}),
		// The cancel-deletion page's whole render hinges on the mutation resolving.
		useBackendOperation: () => ({
			run: vi.fn(async () => ({ ok: true })),
			isLoading: ref(false),
			error: ref(null),
		}),
		// A pure auto-imported util: the real one, so the share page reaches the
		// same branch it reaches in production.
		interpretShareResponse,
	});
	stubRecipientFetch();
});

const pages = [
	{ name: 'unsubscribe', component: UnsubscribePage, loaded: 'Unsubscribe from Emails' },
	{ name: 'preference centre', component: PreferencesPage, loaded: 'Manage Your Email' },
	{
		name: 'double opt-in confirmation',
		component: ConfirmPage,
		loaded: 'Confirm Your Subscription',
	},
	{ name: 'campaign archive', component: ArchivePage, loaded: 'Analytical Engines' },
	{ name: 'shared campaign', component: SharePage, loaded: 'Shared campaign' },
	{ name: 'cancel account deletion', component: CancelDeletionPage, loaded: 'Deletion Cancelled' },
	{ name: 'imprint', component: ImprintPage, loaded: 'Imprint' },
	{ name: 'terms', component: TermsPage, loaded: 'Terms of Service' },
] as const;

describe.each(pages)('$name page — accessibility', ({ component, loaded }) => {
	it('has no axe violations in its loaded state', async () => {
		const violations = await auditA11y(component, {
			global: { plugins: [createTestI18n()] },
			// A page stuck on its spinner (an unstubbed dependency, a rejected
			// fetch) would pass an empty audit; the marker proves the scan ran
			// against the state the recipient actually reads.
			prepare: (wrapper) => expect(wrapper.text()).toContain(loaded),
		});
		expect(violations).toEqual([]);
	});
});
