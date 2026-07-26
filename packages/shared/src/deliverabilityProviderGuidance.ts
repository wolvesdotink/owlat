export type DeliverabilityVpsProvider = 'hetzner' | 'digitalocean' | 'ovh';
export type DeliverabilityDnsProvider = 'cloudflare' | 'hetzner_dns' | 'route53';

export interface DeliverabilityProviderGuidance {
	provider: DeliverabilityVpsProvider | DeliverabilityDnsProvider;
	providerLabel: string;
	summary: string;
	steps: readonly string[];
	consoleHref: string;
}

/** Canonical structured copy rendered by both the docs guide and product checklist. */
export const DELIVERABILITY_VPS_GUIDANCE: Record<
	DeliverabilityVpsProvider,
	DeliverabilityProviderGuidance
> = {
	hetzner: {
		provider: 'hetzner',
		providerLabel: 'Hetzner Cloud',
		summary: 'Hetzner manages reverse DNS beside each server address.',
		steps: [
			'Open the server in Hetzner Console.',
			'Choose Networking.',
			'Edit rDNS beside the exact sending address and save the hostname shown by Owlat.',
		],
		consoleHref: 'https://console.hetzner.cloud/',
	},
	digitalocean: {
		provider: 'digitalocean',
		providerLabel: 'DigitalOcean',
		summary:
			'DigitalOcean derives the PTR from the Droplet name; its documented Droplet policy blocks SMTP ports.',
		steps: [
			'Open the Droplet in the DigitalOcean control panel.',
			'Rename it to the exact fully-qualified hostname shown by Owlat.',
			'Use a verified relay instead of promising a port-25 unblock that DigitalOcean does not support.',
		],
		consoleHref: 'https://cloud.digitalocean.com/droplets',
	},
	ovh: {
		provider: 'ovh',
		providerLabel: 'OVHcloud',
		summary: 'OVHcloud requires the matching forward record before accepting reverse DNS.',
		steps: [
			'Create the matching A or AAAA record first.',
			'Open Network, then Public IP Addresses in OVHcloud Manager.',
			'Choose Configure reverse DNS for the exact sending address.',
		],
		consoleHref: 'https://www.ovh.com/manager/',
	},
};

export const DELIVERABILITY_VPS_PORT25_GUIDANCE: Record<
	DeliverabilityVpsProvider,
	DeliverabilityProviderGuidance
> = {
	hetzner: {
		provider: 'hetzner',
		providerLabel: 'Hetzner Cloud',
		summary: 'Hetzner reviews SMTP limit requests only for established, paid accounts.',
		steps: [
			'Confirm the account is at least one month old and its first invoice is paid.',
			'Submit a limit request for outbound TCP/25 in Hetzner Console.',
			'Use the verified relay on port 587 unless Hetzner confirms the unblock.',
		],
		consoleHref: 'https://console.hetzner.cloud/',
	},
	digitalocean: {
		provider: 'digitalocean',
		providerLabel: 'DigitalOcean',
		summary: 'DigitalOcean documents SMTP ports as blocked on every Droplet.',
		steps: [
			'Do not wait for a direct-to-MX port-25 exception.',
			'Configure a verified external relay supported by your account.',
			'Verify the relay identity and fallback route in Owlat.',
		],
		consoleHref: 'https://cloud.digitalocean.com/droplets',
	},
	ovh: {
		provider: 'ovh',
		providerLabel: 'OVHcloud',
		summary: 'OVHcloud blocks outbound port 25 by default.',
		steps: [
			'Ask OVHcloud support to review an outbound SMTP unblock.',
			'Keep a verified relay on port 587 while the request is pending.',
			'Verify direct delivery only after the live TCP/25 probe passes.',
		],
		consoleHref: 'https://www.ovh.com/manager/',
	},
};

export const DELIVERABILITY_VPS_IPV6_GUIDANCE: Record<
	DeliverabilityVpsProvider,
	DeliverabilityProviderGuidance
> = {
	hetzner: {
		provider: 'hetzner',
		providerLabel: 'Hetzner Cloud',
		summary: "Allocate one stable address from the server's routed IPv6 network.",
		steps: [
			'Open the server Networking view.',
			'Choose one stable address from the assigned IPv6 network.',
			'Route and bind that exact address before publishing DNS.',
		],
		consoleHref: 'https://console.hetzner.cloud/',
	},
	digitalocean: {
		provider: 'digitalocean',
		providerLabel: 'DigitalOcean',
		summary: 'DigitalOcean blocks direct SMTP, including from Droplet IPv6 addresses.',
		steps: [
			'Keep direct IPv6 sending disabled on this provider.',
			'Use a verified external relay instead of allocating IPv6 for direct mail.',
			'Run the Owlat proof through the relay-backed domain.',
		],
		consoleHref: 'https://cloud.digitalocean.com/droplets',
	},
	ovh: {
		provider: 'ovh',
		providerLabel: 'OVHcloud',
		summary: 'Enable and route one stable VPS IPv6 address before DNS setup.',
		steps: [
			'Open the VPS IP configuration in OVHcloud Manager.',
			'Configure one stable routed IPv6 address on the server.',
			'Verify source binding before adding PTR and AAAA records.',
		],
		consoleHref: 'https://www.ovh.com/manager/',
	},
};

export const DELIVERABILITY_DNS_GUIDANCE: Record<
	DeliverabilityDnsProvider,
	DeliverabilityProviderGuidance
> = {
	cloudflare: {
		provider: 'cloudflare',
		providerLabel: 'Cloudflare DNS',
		summary: 'Create the record in the DNS records table for this zone.',
		steps: [
			'Open the domain in Cloudflare.',
			'Choose DNS, then Records.',
			'Add the exact type, name, value, and TTL shown by Owlat; keep mail records DNS-only.',
		],
		consoleHref: 'https://dash.cloudflare.com/',
	},
	hetzner_dns: {
		provider: 'hetzner_dns',
		providerLabel: 'Hetzner DNS',
		summary: 'Create the record in the domain zone, not in the server rDNS screen.',
		steps: [
			'Open the zone in Hetzner DNS Console.',
			'Choose Add record.',
			'Copy the exact type, name, value, and TTL shown by Owlat.',
		],
		consoleHref: 'https://dns.hetzner.com/',
	},
	route53: {
		provider: 'route53',
		providerLabel: 'Amazon Route 53',
		summary: 'Create the record in the public hosted zone for this domain.',
		steps: [
			'Open the public hosted zone in Route 53.',
			'Choose Create record.',
			'Copy the exact record name, type, value, and TTL shown by Owlat.',
		],
		consoleHref: 'https://console.aws.amazon.com/route53/v2/hostedzones',
	},
};
