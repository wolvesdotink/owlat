import { describe, expect, it } from 'vitest';
import { installerProviderNote, type IpAuditVpsProvider } from '../ipAuditProviders';

/** Every documented provider; `satisfies` keeps the list exhaustive. */
const IP_AUDIT_VPS_PROVIDERS = Object.keys({
	hetzner: true,
	digitalocean: true,
	ovh: true,
	vultr: true,
	linode: true,
	scaleway: true,
	aws: true,
	contabo: true,
	other: true,
} satisfies Record<IpAuditVpsProvider, true>) as IpAuditVpsProvider[];

/** The installer hint's length cap: past this it stops reading as a hint. */
const PROVIDER_NOTE_MAX_CHARS = 240;

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
			const { note } = installerProviderNote(provider);
			expect(note.length).toBeLessThanOrEqual(PROVIDER_NOTE_MAX_CHARS);
			expect(note.split(/(?<=\.)\s+/).length).toBeLessThanOrEqual(2);
			expect(note).not.toContain('\n');
		}
	});

	it('states the port-25 policy and the listing propensity as data', () => {
		expect(installerProviderNote('digitalocean').port25Policy).toBe('blocked');
		expect(installerProviderNote('hetzner').port25Policy).toBe('request_after_tenure');
		expect(installerProviderNote('vultr').listingPropensity).toBe('high');
		expect(installerProviderNote('other').port25Policy).toBe('unknown');
	});

	it('falls back to the generic nudge for an unknown provider', () => {
		const note = installerProviderNote('some-vps-i-just-signed-up-for');
		expect(note.provider).toBe('other');
		expect(note.note).toMatch(/block/i);
	});

	it('states which providers need a port-25 request after tenure', () => {
		expect(installerProviderNote('hetzner').port25Policy).toBe('request_after_tenure');
		expect(installerProviderNote('ovh').port25Policy).toBe('request_after_tenure');
		expect(installerProviderNote('digitalocean').port25Policy).not.toBe('request_after_tenure');
	});

	it('recognises only the providers it documents', () => {
		expect(installerProviderNote('hetzner').provider).toBe('hetzner');
		expect(installerProviderNote('not-a-provider').provider).toBe('other');
	});

	it('never promises an unblock a provider does not offer', () => {
		expect(installerProviderNote('digitalocean').note).toMatch(/relay/i);
	});
});
