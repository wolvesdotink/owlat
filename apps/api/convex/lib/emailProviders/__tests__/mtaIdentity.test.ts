/**
 * MTA HTTP client (`MtaIdentityManager`) — the wire contract the H2 backfill and
 * the born-owned forward path depend on: the DKIM register body carries the
 * owning `organizationId`, and the new credential list/PATCH methods hit the
 * right URLs. `fetch` is stubbed so nothing leaves the process.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MtaIdentityManager } from '../mtaIdentity';

const BASE = 'https://mta.example.test';
const KEY = 'master-key';

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

describe('MtaIdentityManager', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const mgr = () => new MtaIdentityManager({ baseUrl: BASE, apiKey: KEY });

	describe('registerDomain', () => {
		it('includes organizationId in the POST body (H2 born-owned)', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({
					success: true,
					selector: 's1',
					dnsRecord: 'v=DKIM1; p=K',
					ownership: 'assigned',
					created: true,
				})
			);

			const result = await mgr().registerDomain('acme.com', undefined, 'org-1');

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(url).toBe(`${BASE}/dkim/acme.com/register`);
			expect(init.method).toBe('POST');
			expect(JSON.parse(init.body as string)).toEqual({ organizationId: 'org-1' });
			expect(result).toMatchObject({ selector: 's1', ownership: 'assigned', created: true });
		});

		it('combines returnPathHost and organizationId in one body', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({ success: true, selector: 's1', dnsRecord: 'v=DKIM1; p=K' })
			);

			await mgr().registerDomain('acme.com', 'bounce.acme.com', 'org-1');

			const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(JSON.parse(init.body as string)).toEqual({
				returnPathHost: 'bounce.acme.com',
				organizationId: 'org-1',
			});
		});

		it('sends NO body when neither field is supplied (historic call)', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({ success: true, selector: 's1', dnsRecord: 'v=DKIM1; p=K' })
			);

			await mgr().registerDomain('acme.com');

			const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(init.body).toBeUndefined();
		});

		it('throws (surfacing the 409) on a cross-org conflict', async () => {
			fetchMock.mockResolvedValue(
				new Response('already registered to a different organization', { status: 409 })
			);

			await expect(mgr().registerDomain('acme.com', undefined, 'org-2')).rejects.toThrow(/409/);
		});
	});

	describe('listOrgCredentials', () => {
		it('requests the full-key list and returns credentials', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({
					credentials: [
						{
							apiKey: 'owlat_full',
							credential: { organizationId: 'org-1', name: 'A', createdAt: 1 },
						},
					],
				})
			);

			const creds = await mgr().listOrgCredentials('org-1');

			const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(url).toBe(`${BASE}/credentials?organizationId=org-1&includeKeys=1`);
			expect(init.method).toBe('GET');
			expect(creds).toHaveLength(1);
			expect(creds[0]!.apiKey).toBe('owlat_full');
		});
	});

	describe('setCredentialAllowedDomains', () => {
		it('PATCHes the credential with the domain list', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ success: true }));

			await mgr().setCredentialAllowedDomains('owlat_abc', ['brand.com', 'brand.net']);

			const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(url).toBe(`${BASE}/credentials/owlat_abc`);
			expect(init.method).toBe('PATCH');
			expect(JSON.parse(init.body as string)).toEqual({
				allowedDomains: ['brand.com', 'brand.net'],
			});
		});

		it('throws on a non-2xx response', async () => {
			fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));

			await expect(mgr().setCredentialAllowedDomains('owlat_x', ['brand.com'])).rejects.toThrow(
				/404/
			);
		});
	});
});
