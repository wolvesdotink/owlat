import { describe, expect, it } from 'vitest';
import { detectDnsProvider, detectVpsProvider, guidanceForCheck } from '../checklistGuidance';

describe('Deliverability Center provider guidance', () => {
	it('detects only bounded authoritative RDAP and NS provider evidence', () => {
		expect(detectVpsProvider('Hetzner Online GmbH')).toBe('hetzner');
		expect(detectVpsProvider('Unknown Hosting')).toBeNull();
		expect(detectDnsProvider(['ada.ns.cloudflare.com.'])).toBe('cloudflare');
		expect(detectDnsProvider(['ns-123.awsdns-45.com'])).toBe('route53');
		expect(detectDnsProvider(['ns.example.test'])).toBeNull();
	});

	it('does not show reverse-DNS steps for a warm-up check', () => {
		const guidance = guidanceForCheck('deployment.warmup', {
			vps: 'hetzner',
			dns: 'cloudflare',
		});
		expect(guidance.provider).toBe('generic');
		expect(guidance.steps.join(' ')).not.toContain('rDNS');
	});

	it('uses provider instructions from the correct action family', () => {
		const port25 = guidanceForCheck('deployment.port25', {
			vps: 'hetzner',
			dns: null,
		});
		expect(port25.steps.join(' ')).toContain('TCP/25');
		expect(port25.steps.join(' ')).not.toContain('rDNS');
		const ipv6 = guidanceForCheck('deployment.ipv6_address', {
			vps: 'digitalocean',
			dns: null,
		});
		expect(ipv6.steps.join(' ')).toContain('relay');
		expect(ipv6.steps.join(' ')).not.toContain('Rename');
	});

	it('does not show DNS-host steps for Postmaster configuration', () => {
		const guidance = guidanceForCheck('domain.postmaster', {
			vps: null,
			dns: 'cloudflare',
		});
		expect(guidance.provider).toBe('generic');
		expect(guidance.steps.join(' ')).not.toContain('Cloudflare');
	});

	it.each([
		'deployment.relay',
		'deployment.warmup',
		'deployment.tls',
		'deployment.ipv6_source',
		'deployment.ipv6_pool',
		'domain.unsubscribe',
		'domain.postmaster',
		'domain.spam_rate',
	] as const)('gives %s an honest action instead of a generic dead end', (itemId) => {
		const guidance = guidanceForCheck(itemId, { vps: null, dns: null });
		expect(guidance.summary).not.toContain('completed inside Owlat');
		expect(guidance.steps[0]).not.toBe('Follow the exact next step shown for this check.');
		expect(guidance.steps[0]?.length).toBeGreaterThan(24);
	});
});
