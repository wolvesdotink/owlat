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
	 */
	async registerDomain(domain: string): Promise<MtaRegistrationResult> {
		const response = await fetch(`${this.baseUrl}/dkim/${encodeURIComponent(domain)}/register`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				'Content-Type': 'application/json',
			},
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
