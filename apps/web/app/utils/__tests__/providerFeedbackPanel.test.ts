/**
 * THE DELIVERY CONFIG PAGE'S FEEDBACK PANEL, pinned per kind.
 *
 * This is the one behaviour P1.2 changed on a shipped dashboard: the SNS card
 * and its live `getLastSesEventAt` poll used to be gated on
 * `status.provider === 'ses'` — trivially auditable by grep — and are now gated
 * on a catalog declaration, which is not. A flipped `hasProviderFeedback`, a
 * mistyped `webhookPath` or a dropped `setupPanel` would make a live panel
 * appear or vanish with the whole suite still green, so every kind's answer is
 * written down here as a literal.
 *
 * The endpoints are literals for the same reason: they are URLs operators have
 * already pasted into an SNS subscription or a Mandrill webhook, and each one is
 * registered by hand in `apps/api/convex/http.ts`. A rename on either side has
 * to break this test rather than silently hand out a 404.
 */
import { describe, expect, it } from 'vitest';
import { CORE_SEND_PROVIDER_CATALOG_ENTRIES } from '@owlat/shared/sendProviderCatalog';
import { providerFeedbackPanel, providerFeedbackWebhookUrl } from '../providerFeedbackPanel';

const SITE = 'https://example.convex.site';

/** Panel and endpoint, as the shipped page renders them today. */
const EXPECTED: Record<string, { panel: string | undefined; url: string }> = {
	// We wire our own MTA's feedback ourselves: a channel, but no ceremony.
	mta: { panel: undefined, url: `${SITE}/webhooks/mta` },
	ses: { panel: 'sns-topic', url: `${SITE}/webhooks/ses` },
	// Feedback and a signing key, but no panel in this app yet — the shipped
	// page has never drawn one for Resend.
	resend: { panel: undefined, url: `${SITE}/webhooks/resend` },
	// No feedback at all: a bring-your-own relay reports nothing.
	smtp: { panel: undefined, url: '' },
	mandrill: { panel: 'signed-webhook', url: `${SITE}/webhooks/mandrill` },
};

describe('the delivery page picks its feedback panel from the catalog', () => {
	it('has an expectation for every kind the catalog declares', () => {
		expect(CORE_SEND_PROVIDER_CATALOG_ENTRIES.map((entry) => entry.kind).sort()).toEqual(
			Object.keys(EXPECTED).sort()
		);
	});

	it.each(Object.entries(EXPECTED))('renders %s as declared', (kind, expected) => {
		expect(providerFeedbackPanel(kind)).toBe(expected.panel);
		expect(providerFeedbackWebhookUrl(kind, SITE)).toBe(expected.url);
	});

	it('draws nothing for a transport this build does not carry', () => {
		expect(providerFeedbackPanel('postmark')).toBeUndefined();
		expect(providerFeedbackPanel(null)).toBeUndefined();
		expect(providerFeedbackPanel(undefined)).toBeUndefined();
		expect(providerFeedbackWebhookUrl('postmark', SITE)).toBe('');
	});

	it('never hands out a relative endpoint when the site URL is unknown', () => {
		// An SNS HTTPS subscription cannot use one; the page hides the block
		// behind its "site URL not configured" hint instead.
		expect(providerFeedbackWebhookUrl('ses', undefined)).toBe('');
		expect(providerFeedbackWebhookUrl('ses', '')).toBe('');
	});

	it('joins a site URL with a trailing slash without doubling it', () => {
		expect(providerFeedbackWebhookUrl('ses', `${SITE}/`)).toBe(`${SITE}/webhooks/ses`);
	});
});
