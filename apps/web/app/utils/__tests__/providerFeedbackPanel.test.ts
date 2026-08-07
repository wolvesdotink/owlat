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
import { describe, expect, it, vi } from 'vitest';
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

/**
 * THE ANSWERING SET — a panel is chosen by mechanism, but the numbers inside it
 * still come from a per-kind backend read.
 *
 * The failure this pins is silent and plausible-looking: a sixth kind declaring
 * `setupPanel: 'signed-webhook'` would render `getMandrillFeedbackStatus`'s key
 * presence and last-event timestamp under its own name, telling an operator
 * their webhook is wired when nothing of theirs was ever read. The whole suite
 * stays green, because the shipped catalog has exactly one kind per mechanism —
 * which is why the kind under test has to be injected.
 */
describe('a panel whose backend read cannot speak for the kind', () => {
	const entry = (kind: string, setupPanel: string) => ({
		kind,
		label: kind,
		retryDelays: [],
		requiredEnvVars: [],
		hasProviderFeedback: true,
		providerFeedback: { webhookPath: `/webhooks/${kind}`, setupPanel },
	});

	async function askAbout(
		kind: string,
		setupPanel: string
	): Promise<{ panel: string | undefined; url: string }> {
		vi.resetModules();
		vi.doMock('@owlat/shared/sendProviderCatalog', async (importOriginal) => {
			const actual = await importOriginal<typeof import('@owlat/shared/sendProviderCatalog')>();
			return {
				...actual,
				coreSendProviderCatalogEntry: (asked: string | undefined) =>
					asked === kind ? entry(kind, setupPanel) : actual.coreSendProviderCatalogEntry(asked),
			};
		});
		const module = await import('../providerFeedbackPanel');
		const answer = {
			panel: module.providerFeedbackPanel(kind) as string | undefined,
			url: module.providerFeedbackWebhookUrl(kind, SITE),
		};
		vi.doUnmock('@owlat/shared/sendProviderCatalog');
		vi.resetModules();
		return answer;
	}

	it('draws no panel for a second signed-webhook kind, rather than Mandrill’s', async () => {
		const { panel, url } = await askAbout('acme-post', 'signed-webhook');
		// The endpoint proves the injected entry IS being read — the panel is
		// withheld by the answering set, not by the kind being unknown.
		expect(url).toBe(`${SITE}/webhooks/acme-post`);
		expect(panel).toBeUndefined();
	});

	it('draws no panel for a second sns-topic kind, rather than SES’s timestamp', async () => {
		const { panel, url } = await askAbout('acme-cloud', 'sns-topic');
		expect(url).toBe(`${SITE}/webhooks/acme-cloud`);
		expect(panel).toBeUndefined();
	});

	it('still draws the shipped panels, so the guard is a set and not an off switch', () => {
		expect(providerFeedbackPanel('ses')).toBe('sns-topic');
		expect(providerFeedbackPanel('mandrill')).toBe('signed-webhook');
	});
});
