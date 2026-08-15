/**
 * THE DRAFT THAT KNOWS NO PROVIDER.
 *
 * Three facts the shared relay draft used to state by naming vendors, and now
 * reads off the catalog — each pinned here against what the shipped surfaces
 * showed, because all three are operator-visible:
 *
 *  - the PICKER: which transports are offered, what they are called, and in what
 *    order (a reordered radio list is a changed screen);
 *  - the PROBE: which transports can be checked before they are applied, which
 *    is the difference between a "Test credentials" button and a line of copy
 *    explaining why there isn't one;
 *  - the REDACTION LIST: which values must never reach the screen or a log.
 */
import { describe, expect, it, vi } from 'vitest';
import { createTestI18n } from '~/__tests__/i18n';
import {
	CORE_SEND_PROVIDER_CATALOG_ENTRIES,
	OWN_SEND_PROVIDER_KIND,
	coreSendProviderCatalogEntry,
} from '@owlat/shared/sendProviderCatalog';
import {
	RELAY_PROVIDER_OPTIONS,
	TRANSPORT_EDITOR_PROVIDER_OPTIONS,
	useRelayCredentialDraft,
} from '../useRelayCredentialDraft';
import { hostPortFieldFor } from '../setupWizardCredentials';

// The picker table is module scope, so its `label`/`hint` are message KEYS that
// the screens resolve with `t()`. Resolving them here keeps the pins below on
// the SENTENCES the operator reads rather than on the key paths behind them.
const { t } = createTestI18n().global;

describe('the transport picker', () => {
	it('offers the relays in the order the shipped screens listed them', () => {
		expect(RELAY_PROVIDER_OPTIONS.map((option) => option.value)).toEqual([
			'ses',
			'smtp',
			'resend',
			'mandrill',
			'emailit',
		]);
	});

	it('leads the editor with the own arm and never offers it as a relay', () => {
		expect(TRANSPORT_EDITOR_PROVIDER_OPTIONS[0]?.value).toBe(OWN_SEND_PROVIDER_KIND);
		expect(RELAY_PROVIDER_OPTIONS.map((o) => o.value)).not.toContain(OWN_SEND_PROVIDER_KIND);
	});

	it('offers every catalog kind exactly once, so a new provider cannot go missing', () => {
		expect([...TRANSPORT_EDITOR_PROVIDER_OPTIONS].map((o) => o.value).sort()).toEqual(
			[...CORE_SEND_PROVIDER_CATALOG_ENTRIES].map((entry) => entry.kind).sort()
		);
	});

	it('shows the labels the shipped editor showed, to the letter', () => {
		// LITERALS, not a read of the catalog: an assertion that each label equals
		// `entry.label` agrees with any label the catalog happens to hold, which is
		// the one thing this pin has to be able to disagree with. The picker's
		// own-arm option is an instruction rather than a name and is the ONE copy
		// override left in the draft; every relay takes the entry's label.
		expect(TRANSPORT_EDITOR_PROVIDER_OPTIONS.map((option) => t(option.label))).toEqual([
			'Run your own MTA',
			'Amazon SES',
			'SMTP relay',
			'Resend',
			'Mailchimp Transactional (Mandrill)',
			'Emailit',
		]);
	});

	it('takes every RELAY’s label from the catalog, not from a second copy', () => {
		for (const option of RELAY_PROVIDER_OPTIONS) {
			// A catalog label carries no message of its own, so `t()` hands it back
			// unchanged — the rendered name is still the entry's.
			expect(t(option.label)).toBe(coreSendProviderCatalogEntry(option.value)?.label);
		}
	});

	it('gives every option an icon, so none renders as an unlabelled row', () => {
		// THE ICON IS THE ONLY GUARANTEE, deliberately. `pickerOption` falls back to
		// the catalog's label and a neutral `lucide:send`, but its hint falls back to
		// `''` — and the providers page states that as a promise: step 7 is "not
		// enforced… nothing breaks". A sixth core kind with no `TRANSPORT_PICKER_COPY`
		// row must therefore be able to ship WITHOUT a red suite in `apps/web`, a
		// package its bundle has no business touching (acceptance criterion A3).
		// Asserting a non-empty hint here was that build break, one file over.
		for (const option of TRANSPORT_EDITOR_PROVIDER_OPTIONS) {
			expect(option.icon).not.toBe('');
			expect(typeof option.hint).toBe('string');
		}
	});

	it('shows the sentences the shipped editor showed, to the letter', () => {
		// The shipped relays plus the own arm DO have copy, and it is
		// operator-facing: pinned as literals for the same reason the labels above
		// are, since a hint read off the table agrees with any rewrite of it.
		expect(TRANSPORT_EDITOR_PROVIDER_OPTIONS.map((option) => t(option.hint))).toEqual([
			'Full control, no third party. Needs port 25 open and a clean sending IP.',
			'Managed deliverability, cheap at scale. Needs an AWS account.',
			'Mailgun, Postmark, SendGrid, Brevo, or any custom SMTP server.',
			'Managed API with a generous free tier.',
			'Arriving from Mailchimp? Keep sending on the reputation you already have, then let the ramp move traffic onto your own MTA.',
			'Managed email API with signed delivery feedback and idempotent sends.',
		]);
	});
});

describe('the pre-apply handshake is a declared capability', () => {
	it.each(CORE_SEND_PROVIDER_CATALOG_ENTRIES.map((entry) => entry.kind))(
		'offers a live check for %s only when its entry declares a setup probe',
		(kind) => {
			const draft = useRelayCredentialDraft(kind);
			expect(draft.canValidateLive.value).toBe(
				coreSendProviderCatalogEntry(kind)?.setupProbe !== undefined
			);
		}
	);

	it('answers null rather than posting a body it cannot build', async () => {
		const draft = useRelayCredentialDraft(OWN_SEND_PROVIDER_KIND);
		await expect(draft.validateLive()).resolves.toBeNull();
	});

	it('probes the port the env patch will actually write', async () => {
		// A blank port means the descriptor's declared default in BOTH places, or
		// the operator tests one endpoint and deploys another.
		const bodies: Record<string, unknown>[] = [];
		vi.stubGlobal(
			'$fetch',
			vi.fn(async (_url: string, options: { body: Record<string, unknown> }) => {
				bodies.push(options.body);
				return { ok: true, message: 'ok' };
			})
		);
		const draft = useRelayCredentialDraft('smtp');
		draft.credentialValues['SMTP_RELAY_PORT'] = '   ';
		await draft.validateLive();
		expect((bodies[0]!['smtp'] as { port: number }).port).toBe(
			Number(hostPortFieldFor('smtp')?.portDefault)
		);

		draft.credentialValues['SMTP_RELAY_PORT'] = '2525';
		await draft.validateLive();
		expect((bodies[1]!['smtp'] as { port: number }).port).toBe(2525);
		// NOT `unstubAllGlobals`: the shared setup file installs Vue's reactivity
		// primitives as globals, and clearing every stub would take those with it.
	});
});

describe('the draft’s state', () => {
	it('seeds every kind’s fields at once, so switching provider keeps what was typed', () => {
		const draft = useRelayCredentialDraft('resend');
		draft.credentialValues['RESEND_API_KEY'] = 're_live_1';
		draft.provider.value = 'ses';
		expect(draft.credentialValues['RESEND_API_KEY']).toBe('re_live_1');
		expect(draft.credentialValues['AWS_SES_REGION']).toBe('us-east-1');
	});

	it('projects the env-keyed values back onto the shipped draft shape', () => {
		const draft = useRelayCredentialDraft('smtp');
		draft.credentialValues['SMTP_RELAY_USERNAME'] = 'postmaster';
		draft.credentialValues['SMTP_RELAY_SECURE'] = 'true';
		expect(draft.credentialFields.value.smtp.username).toBe('postmaster');
		expect(draft.credentialFields.value.smtp.secure).toBe(true);
	});

	it('drops every secret the catalog declares, for every kind, in one call', () => {
		const draft = useRelayCredentialDraft('resend');
		draft.credentialValues['RESEND_API_KEY'] = 're_live_1';
		draft.credentialValues['AWS_SES_SECRET_ACCESS_KEY'] = 'ses-secret';
		draft.credentialValues['MANDRILL_API_KEY'] = 'md-1';
		draft.credentialValues['SMTP_RELAY_PASSWORD'] = 'pw';
		draft.credentialValues['AWS_SES_ACCESS_KEY_ID'] = 'AKIA';

		expect(draft.enteredSecrets.value.filter((value) => value !== '')).toHaveLength(4);
		draft.clearEnteredSecrets();
		expect(draft.enteredSecrets.value.every((value) => value === '')).toBe(true);
		// A non-secret is NOT cleared: the operator would have to retype a region
		// they never entered a secret into.
		expect(draft.credentialValues['AWS_SES_ACCESS_KEY_ID']).toBe('AKIA');
	});

	it('prefills the whole endpoint when a preset is chosen, and frees it on custom', async () => {
		const draft = useRelayCredentialDraft('smtp');
		draft.credentialValues['SMTP_RELAY_HOST'] = 'smtp.typed.test';
		draft.preset.value = 'postmark';
		await Promise.resolve();
		expect(draft.credentialValues['SMTP_RELAY_HOST']).toBe('smtp.postmarkapp.com');

		draft.preset.value = 'custom';
		await Promise.resolve();
		// Custom declares no host, so the operator's value is left alone.
		expect(draft.credentialValues['SMTP_RELAY_HOST']).toBe('smtp.postmarkapp.com');
	});

	it('offers the endpoint presets only for a kind whose descriptor has them', () => {
		expect(useRelayCredentialDraft('smtp').presetOptions.value.length).toBeGreaterThan(0);
		expect(useRelayCredentialDraft('resend').presetOptions.value).toEqual([]);
	});
});
