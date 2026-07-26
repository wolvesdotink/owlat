import { describe, expect, it } from 'vitest';
import {
	installerProviderNote,
	IP_AUDIT_VPS_PROVIDERS,
	isIpAuditVpsProvider,
	PROVIDER_NOTE_MAX_CHARS,
	providersRequiringPort25Request,
	VPS_PORT25_NOTES,
} from '../ipAuditProviders';

describe('installer provider note', () => {
	it('renders a note for every provider', () => {
		for (const provider of IP_AUDIT_VPS_PROVIDERS) {
			const note = installerProviderNote(provider);
			expect(note.provider).toBe(provider);
			expect(note.providerLabel.length).toBeGreaterThan(0);
			expect(note.note.trim().length).toBeGreaterThan(0);
		}
	});

	it('is a nudge, not a lecture: short and at most two sentences', () => {
		for (const provider of IP_AUDIT_VPS_PROVIDERS) {
			const { note } = VPS_PORT25_NOTES[provider];
			expect(note.length).toBeLessThanOrEqual(PROVIDER_NOTE_MAX_CHARS);
			expect(note.split(/(?<=\.)\s+/).length).toBeLessThanOrEqual(2);
			expect(note).not.toContain('\n');
		}
	});

	it('states the port-25 policy and the listing propensity as data', () => {
		expect(VPS_PORT25_NOTES.digitalocean.port25Policy).toBe('blocked');
		expect(VPS_PORT25_NOTES.hetzner.port25Policy).toBe('request_after_tenure');
		expect(VPS_PORT25_NOTES.vultr.listingPropensity).toBe('high');
		expect(VPS_PORT25_NOTES.other.port25Policy).toBe('unknown');
	});

	it('falls back to the generic nudge for an unknown provider', () => {
		const note = installerProviderNote('some-vps-i-just-signed-up-for');
		expect(note.provider).toBe('other');
		expect(note.note).toMatch(/block/i);
	});

	it('lists the providers that need a port-25 request after tenure', () => {
		const providers = providersRequiringPort25Request();
		expect(providers).toContain('hetzner');
		expect(providers).toContain('ovh');
		expect(providers).not.toContain('digitalocean');
	});

	it('recognises only the providers it documents', () => {
		expect(isIpAuditVpsProvider('hetzner')).toBe(true);
		expect(isIpAuditVpsProvider('not-a-provider')).toBe(false);
	});

	it('never promises an unblock a provider does not offer', () => {
		expect(VPS_PORT25_NOTES.digitalocean.note).toMatch(/relay/i);
	});
});
