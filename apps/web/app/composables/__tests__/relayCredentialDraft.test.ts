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
import { describe, expect, it } from 'vitest';
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

describe('the transport picker', () => {
	it('offers the relays in the order the shipped screens listed them', () => {
		expect(RELAY_PROVIDER_OPTIONS.map((option) => option.value)).toEqual([
			'ses',
			'smtp',
			'resend',
			'mandrill',
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

	it('names each transport with the CATALOG’s label, not a second copy of it', () => {
		for (const option of TRANSPORT_EDITOR_PROVIDER_OPTIONS) {
			expect(option.label).toBe(coreSendProviderCatalogEntry(option.value)?.label);
		}
	});

	it('gives every option an icon and a sentence, so none renders as a bare row', () => {
		for (const option of TRANSPORT_EDITOR_PROVIDER_OPTIONS) {
			expect(option.icon).not.toBe('');
			expect(option.hint).not.toBe('');
		}
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
