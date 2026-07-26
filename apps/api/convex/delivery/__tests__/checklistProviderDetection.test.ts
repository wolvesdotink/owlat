import { describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({
	default: { resolveNs: vi.fn(async () => []) },
}));

import dns from 'node:dns/promises';
import { detectDomainDnsProvider } from '../checklistProviderDetection';

describe('checklist DNS provider detection', () => {
	it('walks only as far as the PSL registrable zone', async () => {
		await expect(detectDomainDnsProvider('mail.example.co.uk')).resolves.toBeNull();
		expect(vi.mocked(dns.resolveNs).mock.calls.map(([name]) => name)).toEqual([
			'mail.example.co.uk',
			'example.co.uk',
		]);
		expect(dns.resolveNs).not.toHaveBeenCalledWith('co.uk');
	});
});
