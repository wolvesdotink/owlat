import { getRequired } from '../env';
/**
 * MTA Identity Management Service
 *
 * HTTP client for the MTA's DKIM API endpoints.
 * Handles domain DKIM key generation and deletion.
 */

export interface MtaRegistrationResult {
	selector: string;
	dnsRecord: string; // e.g., "v=DKIM1; k=rsa; p=MIGfMA0..."
}

export class MtaIdentityManager {
	private baseUrl: string;
	private apiKey: string;

	constructor(config: { baseUrl: string; apiKey: string }) {
		this.baseUrl = config.baseUrl.replace(/\/$/, '');
		this.apiKey = config.apiKey;
	}

	/**
	 * Register a domain by generating a DKIM key pair via the MTA's register endpoint.
	 * The MTA generates an RSA 2048-bit key (selector `s{timestamp}`), stores the
	 * private key in Redis, and returns the selector + DNS TXT record value.
	 *
	 * The register endpoint is idempotent: if a key already exists for the domain
	 * (e.g. pre-seeded from the MTA's `DKIM_KEYS` env var) it is returned as-is
	 * rather than overwritten, so registering never breaks an already-published
	 * DKIM DNS record. Use the MTA's dedicated rotate endpoint to replace a key.
	 *
	 * `returnPathHost` sets the domain's per-domain VERP return-path host (D1),
	 * tri-state per the D1 register contract:
	 *   - `undefined` → send NO body: the MTA keeps whatever return-path config it
	 *     had (none by default → the MTA's global `RETURN_PATH_DOMAIN`). This is
	 *     the historic call, byte-identical to before the field existed.
	 *   - a string   → set the per-domain host (a validated DNS FQDN).
	 *   - `null`     → clear any override, reverting the MTA to its global host.
	 * The MTA validates the host and 400s an invalid one; a 400 surfaces here as a
	 * thrown registration error (same taxonomy as any non-2xx).
	 */
	async registerDomain(
		domain: string,
		returnPathHost?: string | null
	): Promise<MtaRegistrationResult> {
		// Only attach a body when the caller expresses an intent for the field
		// (set or clear). `undefined` ⇒ no body ⇒ the MTA's "no change" path.
		const body = returnPathHost === undefined ? undefined : JSON.stringify({ returnPathHost });

		const response = await fetch(`${this.baseUrl}/dkim/${encodeURIComponent(domain)}/register`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				'Content-Type': 'application/json',
			},
			...(body === undefined ? {} : { body }),
		});

		if (!response.ok) {
			const body = await response.text().catch(() => 'Unknown error');
			throw new Error(`MTA DKIM registration failed (${response.status}): ${body}`);
		}

		const result = (await response.json()) as {
			success: boolean;
			domain: string;
			selector: string;
			dnsRecord: string;
		};

		if (!result.success || !result.selector || !result.dnsRecord) {
			throw new Error('MTA did not return a valid DKIM key pair');
		}

		return {
			selector: result.selector,
			dnsRecord: result.dnsRecord,
		};
	}

	/**
	 * Delete a domain's DKIM key from the MTA.
	 */
	async deleteDomain(domain: string): Promise<void> {
		const response = await fetch(`${this.baseUrl}/dkim/${encodeURIComponent(domain)}`, {
			method: 'DELETE',
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
			},
		});

		if (!response.ok) {
			const body = await response.text().catch(() => 'Unknown error');
			throw new Error(`MTA DKIM deletion failed (${response.status}): ${body}`);
		}
	}
}

/**
 * Create an MTA identity manager from environment variables.
 */
export function createMtaIdentityManager(): MtaIdentityManager {
	return new MtaIdentityManager({
		baseUrl: getRequired('MTA_API_URL'),
		apiKey: getRequired('MTA_API_KEY'),
	});
}
