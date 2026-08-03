import { describe, expect, it } from 'vitest';
import {
	deriveTransportDisplay,
	transportLabel,
	type TransportHealthInput,
	type TransportSummaryInput,
} from '../transportState';

function summary(overrides: Partial<TransportSummaryInput> = {}): TransportSummaryInput {
	return {
		provider: 'mta',
		providerLabel: null,
		canSend: true,
		advancedRoutingActive: false,
		health: null,
		...overrides,
	};
}

function health(status: TransportHealthInput['status']): TransportHealthInput {
	return {
		status,
		lastCheckedAt: 1_700_000_000_000,
	};
}

/**
 * THE PROSE VOCABULARY, PINNED WHERE IT LIVES.
 *
 * `transportLabel` is what every sentence that has to NAME the second arm calls
 * it — the independence and measurement subheads, the relay-removal
 * consequence, the measurement comparison column. Those surfaces assert their
 * own sentences; this block pins the naming itself, including the two
 * fall-backs, so a change to it fails here rather than in four prose tests.
 */
describe('transportLabel', () => {
	it('names each built-in kind exactly as the transport card does', () => {
		expect(transportLabel('mta')).toBe('Owlat mail server');
		expect(transportLabel('ses')).toBe('Amazon SES');
		expect(transportLabel('resend')).toBe('Resend');
		expect(transportLabel('smtp')).toBe('SMTP relay');
	});

	it('names a plugin relay by the leaf of its id, not the namespaced id', () => {
		// The ramp and dashboard queries carry the id, not the plugin catalog's
		// display label, so "instead of plugin.mail-pack.postmark" was the shipped
		// sentence. The leaf is the pack's own word for the transport.
		expect(transportLabel('plugin.mail-pack.postmark')).toBe('Postmark');
		expect(transportLabel('plugin.relay-pack.mailgun-eu')).toBe('Mailgun-eu');
	});

	it('falls back to the raw value for anything else', () => {
		// `EMAIL_PROVIDER` can name a transport this build does not know, and a
		// malformed plugin id is not a name to guess at either — both must still
		// read as themselves rather than as "Unknown".
		expect(transportLabel('sendgrid')).toBe('sendgrid');
		expect(transportLabel('plugin.mail-pack')).toBe('plugin.mail-pack');
		expect(transportLabel('plugin.mail-pack.a.b')).toBe('plugin.mail-pack.a.b');
	});
});

describe('deriveTransportDisplay — labels', () => {
	it('names each known transport in human words', () => {
		expect(deriveTransportDisplay(summary({ provider: 'mta' })).label).toBe('Owlat mail server');
		expect(deriveTransportDisplay(summary({ provider: 'ses' })).label).toBe('Amazon SES');
		expect(deriveTransportDisplay(summary({ provider: 'resend' })).label).toBe('Resend');
		expect(deriveTransportDisplay(summary({ provider: 'smtp' })).label).toBe('SMTP relay');
	});

	it('handles no transport selected', () => {
		const d = deriveTransportDisplay(summary({ provider: null, canSend: false }));
		expect(d.label).toBe('No transport selected');
		expect(d.isConfigured).toBe(false);
	});

	it('flags an unrecognized EMAIL_PROVIDER value', () => {
		const d = deriveTransportDisplay(summary({ provider: 'sendgrid', canSend: false }));
		expect(d.label).toContain('sendgrid');
	});

	it('uses the backend catalog label for a bundled plugin transport', () => {
		const d = deriveTransportDisplay(
			summary({
				provider: 'plugin.mail-pack.postmark',
				providerLabel: 'Postmark',
				canSend: true,
			})
		);
		expect(d.label).toBe('Postmark');
		expect(d.description).toContain('Postmark');
		expect(d.label).not.toContain('Unrecognized');
	});
});

describe('deriveTransportDisplay — configured tone', () => {
	it('is success when the instance can send', () => {
		const d = deriveTransportDisplay(summary({ canSend: true }));
		expect(d.configuredTone).toBe('success');
		expect(d.configuredLabel).toBe('Ready to send');
		expect(d.isConfigured).toBe(true);
	});

	it('is error when it cannot', () => {
		const d = deriveTransportDisplay(summary({ canSend: false }));
		expect(d.configuredTone).toBe('error');
		expect(d.configuredLabel).toBe('Not ready');
	});
});

describe('deriveTransportDisplay — health', () => {
	it('is neutral before the first send', () => {
		const d = deriveTransportDisplay(summary({ health: null }));
		expect(d.healthTone).toBe('neutral');
		expect(d.healthLabel).toBe('No sends yet');
	});

	it('maps each provider-health status to the shared tone vocabulary', () => {
		expect(deriveTransportDisplay(summary({ health: health('healthy') })).healthTone).toBe(
			'success'
		);
		expect(deriveTransportDisplay(summary({ health: health('degraded') })).healthTone).toBe(
			'warning'
		);
		expect(deriveTransportDisplay(summary({ health: health('down') })).healthTone).toBe('error');
	});
});
