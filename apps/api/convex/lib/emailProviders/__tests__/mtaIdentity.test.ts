/**
 * MTA HTTP client (`MtaIdentityManager`) — the wire contract the H2 backfill and
 * the born-owned forward path depend on: the DKIM register body carries the
 * owning `organizationId`, and the new credential list/PATCH methods hit the
 * right URLs. `fetch` is stubbed so nothing leaves the process.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MtaIdentityManager } from '../mtaIdentity';
import { internalFailureOf } from '../../../_utils/errors';

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

		it('throws the typed ownership conflict on a cross-org 409', async () => {
			fetchMock.mockResolvedValue(
				new Response('already registered to a different organization', { status: 409 })
			);

			const error = await mgr()
				.registerDomain('acme.com', undefined, 'org-2')
				.catch((thrown: unknown) => thrown);
			expect(internalFailureOf(error)).toEqual({
				kind: 'mta.dkim_ownership_conflict',
				retryable: false,
				attrs: { status: 409 },
			});
			// The MTA's text stays the message the domain's failure record shows,
			// and stays out of the serialized payload.
			expect((error as Error).message).toBe(
				'MTA DKIM registration failed (409): already registered to a different organization'
			);
			expect(JSON.stringify((error as { data: unknown }).data)).not.toContain('already registered');
		});

		it('refuses a key pair whose fields are not text, and omits an ownership it does not know', async () => {
			fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, selector: 1, dnsRecord: 'x' }));
			await expect(mgr().registerDomain('acme.com')).rejects.toThrow(
				'MTA did not return a valid DKIM key pair'
			);

			fetchMock.mockResolvedValueOnce(
				jsonResponse({ success: true, selector: 's1', dnsRecord: 'v=DKIM1', ownership: 'moved' })
			);
			expect(await mgr().registerDomain('acme.com')).toEqual({
				selector: 's1',
				dnsRecord: 'v=DKIM1',
			});
		});

		it('throws a plain error for any other refusal, whatever its text', async () => {
			fetchMock.mockResolvedValue(new Response('conflict (409) upstream', { status: 500 }));

			const error = await mgr()
				.registerDomain('acme.com', undefined, 'org-2')
				.catch((thrown: unknown) => thrown);
			expect(internalFailureOf(error)).toBeNull();
			expect((error as Error).message).toContain('(500)');
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

		it('refuses a list whose allowed domains are not a list of text', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({
					credentials: [{ apiKey: 'owlat_full', credential: { allowedDomains: 'acme.com' } }],
				})
			);

			await expect(mgr().listOrgCredentials('org-1')).rejects.toThrow(/unexpected answer/);
		});

		it('refuses an answer without a credentials list instead of reading it as empty', async () => {
			fetchMock.mockResolvedValue(jsonResponse({}));

			await expect(mgr().listOrgCredentials('org-1')).rejects.toThrow(/unexpected answer/);
		});

		it('returns an empty list when the MTA answers with no credentials', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ credentials: [] }));

			await expect(mgr().listOrgCredentials('org-1')).resolves.toEqual([]);
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
