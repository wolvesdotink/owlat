import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(resolve(here, '../provider-routing.vue'), 'utf8');
const source = readFileSync(
	resolve(here, '../../../../components/delivery/RelayDomainStatus.vue'),
	'utf8'
);

describe('provider-routing SES relay operations surface', () => {
	it('keeps the operational SES identity panel as a cohesive page component', () => {
		expect(pageSource).toContain('<DeliveryRelayDomainStatus />');
	});

	it('loads the protected relay-domain query and wires the existing DNS verifier', () => {
		expect(source).toContain('api.providerRoutes.listDeliverabilityRelayDomains');
		expect(source).toContain('api.domains.dnsVerification.verifyDomain');
		expect(source).toMatch(/verifyRelayDomain\(\{ domainId \}\)/);
	});

	it('renders exact DNS values and provider verification status', () => {
		expect(source).toContain('data-testid="relay-domain-status"');
		expect(source).toContain('SES status: {{ domain.status }}');
		expect(source).toMatch(
			/\{\{ record\.type \}\}\s+\{\{ record\.host \?\? record\.hostname\s*\}\}/
		);
		expect(source).toContain('{{ record.value }}');
		expect(source).toContain('Verify DNS');
	});

	it('states the merged-SPF and unchanged-DMARC requirements without claiming instant readiness', () => {
		expect(source).toContain('replaces the existing SPF record');
		expect(source).toContain('Your primary DMARC record remains unchanged');
		expect(source).toContain('Provisioning is queued');
		expect(source).toContain('Verify the primary owned-MTA domain first');
		expect(source).toContain('Showing the first 512 owned-MTA domains');
	});
});
