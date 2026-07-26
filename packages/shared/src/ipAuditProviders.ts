/**
 * Installer provider guidance for outbound port 25.
 *
 * The single most common self-hosting dead end is a provider that blocks
 * outbound TCP/25 without saying so. This is a NUDGE, not a lecture: one short,
 * factual note per provider covering whether port 25 is open, whether it needs
 * a request after some account tenure, and whether the provider's ranges tend
 * to arrive already blocklisted.
 *
 * Every note is capped so it renders as an inline hint, never a wall of text.
 */

export const IP_AUDIT_VPS_PROVIDERS = [
	'hetzner',
	'digitalocean',
	'ovh',
	'vultr',
	'linode',
	'scaleway',
	'aws',
	'contabo',
	'other',
] as const;
export type IpAuditVpsProvider = (typeof IP_AUDIT_VPS_PROVIDERS)[number];

export type Port25Policy = 'open' | 'request_after_tenure' | 'blocked' | 'unknown';
export type ListingPropensity = 'low' | 'moderate' | 'high' | 'unknown';

export interface VpsPort25Note {
	provider: IpAuditVpsProvider;
	providerLabel: string;
	port25Policy: Port25Policy;
	listingPropensity: ListingPropensity;
	/** One or two short factual sentences. */
	note: string;
}

/** Hard cap so the installer hint stays a hint. */
export const PROVIDER_NOTE_MAX_CHARS = 240;

export const VPS_PORT25_NOTES: Record<IpAuditVpsProvider, VpsPort25Note> = {
	hetzner: {
		provider: 'hetzner',
		providerLabel: 'Hetzner Cloud',
		port25Policy: 'request_after_tenure',
		listingPropensity: 'moderate',
		note: 'Port 25 stays closed until you request an SMTP unblock, and Hetzner reviews that only for paid accounts with some history. Their ranges are sometimes already listed.',
	},
	digitalocean: {
		provider: 'digitalocean',
		providerLabel: 'DigitalOcean',
		port25Policy: 'blocked',
		listingPropensity: 'high',
		note: 'DigitalOcean blocks SMTP ports on every Droplet and does not lift it. Plan on a relay here rather than direct delivery.',
	},
	ovh: {
		provider: 'ovh',
		providerLabel: 'OVHcloud',
		port25Policy: 'request_after_tenure',
		listingPropensity: 'moderate',
		note: 'OVHcloud blocks outbound port 25 by default and unblocks it by support ticket. Keep a relay configured while the request is pending.',
	},
	vultr: {
		provider: 'vultr',
		providerLabel: 'Vultr',
		port25Policy: 'request_after_tenure',
		listingPropensity: 'high',
		note: 'Vultr opens port 25 by support request once an account has some tenure. Their ranges are frequently listed on arrival, so audit the address first.',
	},
	linode: {
		provider: 'linode',
		providerLabel: 'Akamai Linode',
		port25Policy: 'request_after_tenure',
		listingPropensity: 'moderate',
		note: 'Linode blocks port 25 on new accounts and lifts it after a support review. Ask before you build DNS around the address.',
	},
	scaleway: {
		provider: 'scaleway',
		providerLabel: 'Scaleway',
		port25Policy: 'request_after_tenure',
		listingPropensity: 'moderate',
		note: 'Scaleway blocks SMTP by default and enables it per account on request. Reverse DNS is configurable per address.',
	},
	aws: {
		provider: 'aws',
		providerLabel: 'Amazon EC2',
		port25Policy: 'request_after_tenure',
		listingPropensity: 'high',
		note: 'EC2 throttles port 25 until you file the sending-limit form, and EC2 ranges are widely distrusted. Elastic IPs also need a reverse-DNS request.',
	},
	contabo: {
		provider: 'contabo',
		providerLabel: 'Contabo',
		port25Policy: 'request_after_tenure',
		listingPropensity: 'high',
		note: 'Contabo opens port 25 on request, but its ranges are commonly listed on arrival. Audit the address before investing in DNS.',
	},
	other: {
		provider: 'other',
		providerLabel: 'Another provider',
		port25Policy: 'unknown',
		listingPropensity: 'unknown',
		note: 'Many providers block outbound port 25 silently. The audit below tests it directly, so you find out in seconds rather than after setup.',
	},
};

export function isIpAuditVpsProvider(value: string): value is IpAuditVpsProvider {
	return IP_AUDIT_VPS_PROVIDERS.includes(value as IpAuditVpsProvider);
}

/** The short installer note for one provider; falls back to the generic nudge. */
export function installerProviderNote(provider: string): VpsPort25Note {
	return isIpAuditVpsProvider(provider) ? VPS_PORT25_NOTES[provider] : VPS_PORT25_NOTES.other;
}

/** Providers whose port-25 policy is worth flagging before the operator commits. */
export function providersRequiringPort25Request(): IpAuditVpsProvider[] {
	return IP_AUDIT_VPS_PROVIDERS.filter(
		(provider) => VPS_PORT25_NOTES[provider].port25Policy === 'request_after_tenure'
	);
}
