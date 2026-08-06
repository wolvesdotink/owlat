// @vitest-environment happy-dom
/**
 * THE ONE CREDENTIAL FORM, mounted for every kind the catalog declares.
 *
 * The suite iterates `CORE_SEND_PROVIDER_CATALOG_ENTRIES` rather than a list of
 * vendor names, and asserts the rendered controls against the DESCRIPTORS — so
 * it is the same assertion for a provider that does not exist yet, and it fails
 * the day a form stops matching what its entry declares. That is the property
 * P1.2 is actually claiming: the renderer knows field KINDS, never providers.
 *
 * The ids it finds inputs by (`#field-resend-api-key`) are derived from the
 * LABEL by the shared stub, exactly as the shipped wizard suites do it — which
 * is what makes "the label is the catalog's" a checkable statement rather than a
 * comment.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { CORE_SEND_PROVIDER_CATALOG_ENTRIES } from '@owlat/shared/sendProviderCatalog';
import TransportCredentialFields from '../TransportCredentialFields.vue';
import {
	credentialFieldsFor,
	seedCredentialValues,
	type TransportCredentialValues,
} from '~/composables/setupWizardCredentials';
import type { SmtpPreset } from '~/composables/useSetupWizard';
import { wizardStubs } from './wizardHarness';

const KINDS = CORE_SEND_PROVIDER_CATALOG_ENTRIES.map((entry) => entry.kind);

/** The id the stubbed input/label pair share — the harness's own derivation. */
function fieldId(label: string): string {
	return `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function mountFields(
	kind: string,
	options: {
		values?: TransportCredentialValues;
		preset?: SmtpPreset;
		error?: string;
	} = {}
) {
	const values = options.values ?? seedCredentialValues(kind);
	const wrapper = mount(TransportCredentialFields, {
		props: {
			kind,
			values,
			preset: options.preset ?? 'mailgun',
			presetOptions: [
				{ value: 'mailgun' as SmtpPreset, label: 'Mailgun' },
				{ value: 'custom' as SmtpPreset, label: 'Custom SMTP server' },
			],
			error: options.error,
		},
		global: { stubs: wizardStubs },
	});
	return { wrapper, values };
}

describe('TransportCredentialFields — one renderer, every kind', () => {
	it.each(KINDS)('draws a labelled control for each field %s declares', (kind) => {
		const { wrapper } = mountFields(kind);
		for (const field of credentialFieldsFor(kind)) {
			const control = wrapper.find(`#${fieldId(field.label)}`);
			expect(control.exists()).toBe(true);
			// Only a `secret` is masked; nothing else pretends to be one.
			if (field.kind === 'secret') expect(control.attributes('type')).toBe('password');
			else if (control.element.tagName === 'INPUT') {
				expect(control.attributes('type')).not.toBe('password');
			}
		}
	});

	it.each(KINDS)('writes what is typed into %s straight onto its env variable', (kind) => {
		const { wrapper, values } = mountFields(kind);
		for (const field of credentialFieldsFor(kind)) {
			if (field.kind !== 'string' && field.kind !== 'secret' && field.kind !== 'region-select') {
				continue;
			}
			wrapper.find(`#${fieldId(field.label)}`).setValue(`typed-${field.key}`);
			expect(values[field.envVar]).toBe(`typed-${field.key}`);
		}
	});

	it('renders nothing at all for a transport this build does not carry', () => {
		const { wrapper } = mountFields('postmark');
		expect(wrapper.findAll('input')).toHaveLength(0);
		expect(wrapper.findAll('select')).toHaveLength(0);
	});

	it('renders the entry’s own operator guidance where it declares one', () => {
		// Mandrill's descriptor carries the note about the SIGNING key it does not
		// collect here; it travels with the provider, not with this component.
		expect(mountFields('mandrill').wrapper.text()).toContain('MANDRILL_WEBHOOK_KEY');
	});
});

describe('TransportCredentialFields — the host-port composite', () => {
	it('draws the endpoint as preset + host + port + implicit TLS', () => {
		const { wrapper } = mountFields('smtp');
		expect(wrapper.find('#field-provider-preset').exists()).toBe(true);
		expect(wrapper.find('#field-server-host').exists()).toBe(true);
		expect(wrapper.find('#field-port').exists()).toBe(true);
		expect(wrapper.find('input[type="checkbox"]').exists()).toBe(true);
	});

	it('locks the host on a named preset and frees it on the custom endpoint', () => {
		expect(mountFields('smtp').wrapper.find('#field-server-host').attributes('disabled')).toBe('');
		const custom = mountFields('smtp', { preset: 'custom' });
		expect(custom.wrapper.find('#field-server-host').attributes('disabled')).toBeUndefined();
	});

	it('writes the implicit-TLS toggle back as an explicit true/false', async () => {
		const { wrapper, values } = mountFields('smtp');
		const box = wrapper.find('input[type="checkbox"]');
		await box.setValue(true);
		expect(values['SMTP_RELAY_SECURE']).toBe('true');
		await box.setValue(false);
		expect(values['SMTP_RELAY_SECURE']).toBe('false');
	});

	it('hints the host with the descriptor’s example, as the shipped form did', () => {
		const { wrapper } = mountFields('smtp', { preset: 'custom' });
		expect(wrapper.find('#field-server-host').attributes('placeholder')).toBe('smtp.mailgun.org');
		// Both halves of one endpoint hint, or neither: the port already showed its
		// declared default.
		expect(wrapper.find('#field-port').attributes('placeholder')).toBe('587');
	});

	it('withholds the implicit-TLS toggle from a surface that never offered it', () => {
		// The connect-a-provider wizard's step rendered preset/host/port/user/pass
		// and no TLS control; sharing this renderer must not hand it a new one.
		const wrapper = mount(TransportCredentialFields, {
			props: {
				kind: 'smtp',
				values: seedCredentialValues('smtp'),
				preset: 'mailgun' as SmtpPreset,
				presetOptions: [{ value: 'mailgun' as SmtpPreset, label: 'Mailgun' }],
				endpointSecurityToggle: false,
			},
			global: { stubs: wizardStubs },
		});
		expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false);
		// The rest of the endpoint is untouched.
		expect(wrapper.find('#field-server-host').exists()).toBe(true);
		expect(wrapper.find('#field-port').exists()).toBe(true);
	});

	it('asks the parent to change preset rather than changing it behind its back', async () => {
		const { wrapper } = mountFields('smtp');
		await wrapper.find('#field-provider-preset').setValue('custom');
		expect(wrapper.emitted('update:preset')).toEqual([['custom']]);
	});
});

describe('TransportCredentialFields — where a credential error is announced', () => {
	const ERROR = 'Credentials are required.';

	it.each(['resend', 'mandrill'])(
		'binds %s’s error to its one control, which is what its shipped block did',
		(kind) => {
			const only = credentialFieldsFor(kind)[0]!;
			const { wrapper } = mountFields(kind, { error: ERROR });
			const alerts = wrapper.findAll('[role="alert"]');
			expect(alerts).toHaveLength(1);
			expect(alerts[0]!.text()).toBe(ERROR);
			// Inside the field's own wrapper, so the input beside it is the one a
			// screen reader lands on.
			expect(alerts[0]!.element.parentElement?.querySelector('input')?.id).toBe(
				fieldId(only.label)
			);
		}
	);

	it.each(['ses', 'smtp'])(
		'renders %s’s SET-level message after the group, bound to no single input',
		(kind) => {
			const { wrapper } = mountFields(kind, { error: ERROR });
			const alerts = wrapper.findAll('[role="alert"]');
			expect(alerts).toHaveLength(1);
			expect(alerts[0]!.text()).toBe(ERROR);
			// The regression this pins: bound to a control, "Port must be a whole
			// number…" appeared under the DISABLED host input, and a filled-in SES
			// region was marked invalid because the missing field was the secret
			// below it. A set-level paragraph sits beside the group, not inside a
			// field, so no input owns it.
			expect(alerts[0]!.element.tagName).toBe('P');
			expect(alerts[0]!.element.parentElement).toBe(wrapper.element);
			expect(alerts[0]!.element.querySelector('input')).toBeNull();
		}
	);

	it('announces nothing when the step has no credential error', () => {
		expect(mountFields('ses').wrapper.findAll('[role="alert"]')).toHaveLength(0);
		expect(mountFields('resend').wrapper.findAll('[role="alert"]')).toHaveLength(0);
	});

	it.each(KINDS)('never drops %s’s error on the floor', (kind) => {
		// Whichever placement the form's shape earns, the message is on screen.
		if (credentialFieldsFor(kind).length === 0) return;
		expect(mountFields(kind, { error: ERROR }).wrapper.text()).toContain(ERROR);
	});
});

describe('TransportCredentialFields — the per-field slot', () => {
	it('renders a surface’s extra copy under the field it names, and only there', () => {
		const wrapper = mount(TransportCredentialFields, {
			props: {
				kind: 'mta',
				values: seedCredentialValues('mta'),
				preset: 'custom' as SmtpPreset,
				presetOptions: [],
			},
			slots: { outboundTlsMode: '<p data-testid="tls-hint">the floor’s guidance</p>' },
			global: { stubs: wizardStubs },
		});
		expect(wrapper.find('[data-testid="tls-hint"]').exists()).toBe(true);

		const other = mount(TransportCredentialFields, {
			props: {
				kind: 'resend',
				values: seedCredentialValues('resend'),
				preset: 'custom' as SmtpPreset,
				presetOptions: [],
			},
			slots: { outboundTlsMode: '<p data-testid="tls-hint">the floor’s guidance</p>' },
			global: { stubs: wizardStubs },
		});
		expect(other.find('[data-testid="tls-hint"]').exists()).toBe(false);
	});
});
