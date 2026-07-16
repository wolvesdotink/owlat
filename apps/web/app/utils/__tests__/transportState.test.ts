import { describe, expect, it } from 'vitest';
import {
	deriveTransportDisplay,
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
