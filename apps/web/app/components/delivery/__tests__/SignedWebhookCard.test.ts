// @vitest-environment happy-dom
/**
 * The webhook setup card's job is to be COPYABLE and COMPLETE: the exact URL,
 * the exact events, and the one variable that is not part of sending. The
 * assertions below are the things an operator cannot recover from being told
 * wrong — and, since the card serves EVERY kind declaring the `signed-webhook`
 * ceremony, the sharpest of them is that the variable name and the provider name
 * belong to the ACTIVE kind. The Mandrill-only version of this card told an
 * Emailit operator to set `MANDRILL_WEBHOOK_KEY`, which the backend does not
 * read, so the "missing" chip beside it never cleared.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed } from 'vue';
import {
	coreSendProviderCatalogEntry,
	type CoreSendProviderKind,
} from '@owlat/shared/sendProviderCatalog';
import { transportKindLabel } from '~/utils/transportState';
import SignedWebhookCard from '../SignedWebhookCard.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

/** The kind vocabulary is keyed; the page resolves it before handing it over. */
const { t } = createTestI18n().global;
const localized = (value: string | { key: string; params?: Record<string, unknown> }): string =>
	typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});

const stubs = {
	Icon: { template: '<i />' },
	UiCard: { template: '<div><slot name="header" /><slot /></div>' },
	UiIconBox: { template: '<i />' },
};

beforeEach(() => {
	vi.stubGlobal('computed', computed);
	vi.stubGlobal('useCopyToClipboard', () => ({ copy: vi.fn(), isCopied: () => false }));
	// The card's copy flows through vue-i18n now; `useI18n` is a Nuxt auto-import,
	// so it has to exist as a bare global for the component's setup.
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

function mountCard(props: Partial<InstanceType<typeof SignedWebhookCard>['$props']> = {}) {
	return mount(SignedWebhookCard, {
		props: {
			providerKind: 'mandrill',
			providerLabel: 'Mailchimp Transactional',
			signingKeyEnvVar: 'MANDRILL_WEBHOOK_KEY',
			webhookUrl: 'https://acme.convex.site/webhooks/mandrill',
			isWebhookKeyPresent: true,
			lastEventAt: null,
			...props,
		},
		global: { stubs, plugins: [createTestI18n()] },
	});
}

/**
 * The card as the delivery page mounts it for a kind: the same three vendor
 * facts, read from the same catalog entry the page reads.
 */
function mountForKind(
	kind: CoreSendProviderKind,
	props: Partial<InstanceType<typeof SignedWebhookCard>['$props']> = {}
) {
	const entry = coreSendProviderCatalogEntry(kind);
	return mountCard({
		providerKind: kind,
		// The page's own label derivation, not `entry.label`: the two differ for
		// Mandrill, and this card renders whatever the page hands it — a resolved
		// name, since `transportKindLabel` returns the catalog key.
		providerLabel: localized(transportKindLabel(kind)),
		signingKeyEnvVar: entry?.providerFeedback?.signingKeyEnvVar ?? '',
		webhookUrl: `https://acme.convex.site${entry?.providerFeedback?.webhookPath ?? ''}`,
		...props,
	});
}

describe('SignedWebhookCard', () => {
	it('renders the exact endpoint the provider signs over', () => {
		const url = mountCard().find('[data-testid="signed-webhook-url"]');
		expect(url.text()).toBe('https://acme.convex.site/webhooks/mandrill');
	});

	it('hides the endpoint rather than emitting a relative path when the site URL is unknown', () => {
		const wrapper = mountCard({ webhookUrl: '' });
		expect(wrapper.find('[data-testid="signed-webhook-url"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="signed-webhook-no-url"]').text()).toContain(
			'Set your site URL'
		);
	});

	it('tells the operator to leave open/click OFF, and says why', () => {
		// Plan D3: first-party tracking instruments BOTH arms identically, which is
		// the only reason the engagement ramp gate can compare them. True of every
		// provider, so this note is not per-kind copy.
		const note = mountCard().find('[data-testid="signed-webhook-tracking-events-off"]');
		expect(note.text()).toContain('open');
		expect(note.text()).toContain('click');
		expect(note.text()).toContain('first-party');
	});

	it('shows the signing key as present/missing, never as a value', () => {
		expect(
			mountCard({ isWebhookKeyPresent: false })
				.find('[data-testid="signed-webhook-key-presence"]')
				.text()
		).toBe('missing');
		expect(mountCard().find('[data-testid="signed-webhook-key-presence"]').text()).toBe('present');
	});

	it('reports whether feedback has ever actually arrived', () => {
		expect(mountCard().find('[data-testid="signed-webhook-last-event"]').text()).toContain(
			'No feedback received yet'
		);
		expect(
			mountCard({ lastEventAt: Date.UTC(2026, 7, 4) })
				.find('[data-testid="signed-webhook-last-event"]')
				.text()
		).toContain('Last event received');
	});
});

describe('the card speaks for the ACTIVE kind, not for Mandrill', () => {
	it('gives Mandrill its full instructions, key caveat included', () => {
		const wrapper = mountForKind('mandrill');
		const text = wrapper.text();
		expect(wrapper.find('[data-testid="signed-webhook-title"]').text()).toBe(
			'Mailchimp Transactional feedback webhook'
		);
		expect(text).toContain('MANDRILL_WEBHOOK_KEY');
		// The events Owlat consumes, and no others.
		for (const event of [
			'send',
			'deferral',
			'hard_bounce',
			'soft_bounce',
			'spam',
			'unsub',
			'reject',
		]) {
			expect(wrapper.find('[data-testid="signed-webhook-events"]').text()).toContain(event);
		}
		expect(wrapper.find('[data-testid="signed-webhook-key-note"]').text()).toContain(
			'Mandrill shows this key once'
		);
		expect(wrapper.find('[data-testid="signed-webhook-url-note"]').text()).toContain(
			'Mandrill checks the URL before saving the webhook'
		);
	});

	it('names EMAILIT_WEBHOOK_SECRET for Emailit, and no Mandrill copy anywhere', () => {
		const wrapper = mountForKind('emailit');
		const text = wrapper.text();
		expect(wrapper.find('[data-testid="signed-webhook-title"]').text()).toBe(
			'Emailit feedback webhook'
		);
		expect(text).toContain('EMAILIT_WEBHOOK_SECRET');
		expect(text).toContain('https://acme.convex.site/webhooks/emailit');
		expect(text).toContain('Create a webhook in your Emailit console');
		// Nothing from the other vendor: not its variable, not its name, not its
		// event vocabulary, not its "shown once" caveat.
		expect(text).not.toContain('MANDRILL_WEBHOOK_KEY');
		expect(text).not.toMatch(/Mandrill|Mailchimp/);
		expect(text).not.toContain('hard_bounce');
		expect(wrapper.find('[data-testid="signed-webhook-events"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="signed-webhook-events-generic"]').text()).toContain(
			'Emailit'
		);
	});

	it('keeps the presence chip reading the key the ACTIVE kind actually needs', () => {
		// The chip is computed by the page from the backend's missing-variable list
		// for this transport; what the card must get right is which variable it is
		// standing next to.
		const missing = mountForKind('emailit', { isWebhookKeyPresent: false });
		expect(missing.find('[data-testid="signed-webhook-key-presence"]').text()).toBe('missing');
		expect(missing.find('[data-testid="signed-webhook-key-note"]').text()).toContain('Emailit');
	});

	it('still draws a usable ceremony for a kind with no per-kind copy at all', () => {
		// A sixth provider declaring `signed-webhook` gets the generic instructions
		// with ITS name and ITS variable — never a placeholder and never Mandrill's.
		const wrapper = mountCard({
			providerKind: 'acme-post',
			providerLabel: 'Acme Post',
			signingKeyEnvVar: 'ACME_POST_WEBHOOK_SECRET',
			webhookUrl: 'https://acme.convex.site/webhooks/acme-post',
		});
		const text = wrapper.text();
		expect(text).toContain('Acme Post feedback webhook');
		expect(text).toContain('ACME_POST_WEBHOOK_SECRET');
		expect(text).toContain('Acme Post issues this key when the webhook is created');
		expect(text).not.toMatch(/Mandrill|Mailchimp/);
	});
});
