import { v, type Infer } from 'convex/values';
import { validatorDecoder } from '@owlat/worker-protocol/decodeJson';
import { getRequired } from '../env';
import { InternalFailure } from '../../_utils/errors';
/**
 * MTA Identity Management Service
 *
 * HTTP client for the MTA's DKIM API endpoints.
 * Handles domain DKIM key generation and deletion.
 */

interface MtaRegistrationResult {
	selector: string;
	dnsRecord: string; // e.g., "v=DKIM1; k=rsa; p=MIGfMA0..."
	/** Whether the MTA generated a brand-new key (vs. returning an existing one). */
	created?: boolean;
	/**
	 * What the register call did to the domain's DKIM org-ownership binding (H2):
	 * `assigned` (now owned by the supplied org), `unchanged` (already owned by
	 * it), or `unowned` (no org supplied / key carries no owner). Absent on
	 * responses from an older MTA that predates the field. The ownership-backfill
	 * migration reads this to tally outcomes.
	 */
	ownership?: 'assigned' | 'unchanged' | 'unowned';
}

/**
 * One entry of the MTA's `GET /credentials?includeKeys=1` list, as far as the
 * allowedDomains backfill reads it.
 */
const mtaOrgCredentialValidator = v.object({
	apiKey: v.string(),
	credential: v.object({ allowedDomains: v.optional(v.array(v.string())) }),
});
type MtaOrgCredential = Infer<typeof mtaOrgCredentialValidator>;

/**
 * The MTA always answers the list with a `credentials` array, so an answer
 * without one is refused: reading it as an empty list would let the backfill
 * report success without scoping a single credential.
 */
const decodeCredentialList = validatorDecoder(
	v.object({ credentials: v.array(mtaOrgCredentialValidator) })
);

/** The MTA's DKIM registration answer. */
const decodeDkimRegistration = validatorDecoder(
	v.object({
		success: v.boolean(),
		selector: v.string(),
		dnsRecord: v.string(),
		created: v.optional(v.boolean()),
		/** Read as text: an outcome this build does not know is left out, not refused. */
		ownership: v.optional(v.string()),
	})
);

const DKIM_OWNERSHIP_OUTCOMES = ['assigned', 'unchanged', 'unowned'] as const;
type DkimOwnership = (typeof DKIM_OWNERSHIP_OUTCOMES)[number];
const isDkimOwnership = (value: string): value is DkimOwnership =>
	(DKIM_OWNERSHIP_OUTCOMES as readonly string[]).includes(value);

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
	 * `returnPathHost` sets the domain's per-domain VERP return-path host,
	 * tri-state per the MTA's register contract:
	 *   - `undefined` → send NO body: the MTA keeps whatever return-path config it
	 *     had (none by default → the MTA's global `RETURN_PATH_DOMAIN`). This is
	 *     the historic call, byte-identical to before the field existed.
	 *   - a string   → set the per-domain host (a validated DNS FQDN).
	 *   - `null`     → clear any override, reverting the MTA to its global host.
	 * The MTA validates the host and 400s an invalid one; a 400 surfaces here as a
	 * thrown registration error (same taxonomy as any non-2xx).
	 *
	 * `organizationId` binds the domain's DKIM key to its owning tenant (H2). New
	 * keys are born owned; an existing unowned key is backfilled; a cross-org clash
	 * surfaces as the MTA's 409, thrown here as the `mta.dkim_ownership_conflict`
	 * internal failure. Absent ⇒ no org is sent (the historic call, unchanged).
	 */
	async registerDomain(
		domain: string,
		returnPathHost?: string | null,
		organizationId?: string
	): Promise<MtaRegistrationResult> {
		// Only attach a body when the caller expresses an intent for a field
		// (return-path set/clear, or an owning org). No intent ⇒ no body ⇒ the MTA's
		// "no change" path, byte-identical to the historic call.
		const payload: { returnPathHost?: string | null; organizationId?: string } = {};
		if (returnPathHost !== undefined) payload.returnPathHost = returnPathHost;
		if (organizationId !== undefined) payload.organizationId = organizationId;
		const body = Object.keys(payload).length === 0 ? undefined : JSON.stringify(payload);

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
			const message = `MTA DKIM registration failed (${response.status}): ${body}`;
			// The one refusal a caller branches on: the key is bound to another
			// organization. Typed so the caller never reads the status out of the
			// text; the text stays the message the domain's failure record shows.
			if (response.status === 409) {
				throw new InternalFailure('mta.dkim_ownership_conflict', {
					retryable: false,
					attrs: { status: 409 },
					message,
				});
			}
			throw new Error(message);
		}

		const decoded = decodeDkimRegistration(await response.json());
		if (!decoded.ok) throw new Error('MTA did not return a valid DKIM key pair');
		const result = decoded.value;
		if (!result.success || !result.selector || !result.dnsRecord) {
			throw new Error('MTA did not return a valid DKIM key pair');
		}

		return {
			selector: result.selector,
			dnsRecord: result.dnsRecord,
			...(result.created !== undefined ? { created: result.created } : {}),
			...(result.ownership !== undefined && isDkimOwnership(result.ownership)
				? { ownership: result.ownership }
				: {}),
		};
	}

	/**
	 * List an organization's MTA API credentials WITH their full keys (via
	 * `?includeKeys=1`, master-key protected). Used by the allowedDomains backfill
	 * migration, which must PATCH each credential by its full key.
	 */
	async listOrgCredentials(organizationId: string): Promise<MtaOrgCredential[]> {
		const url = `${this.baseUrl}/credentials?organizationId=${encodeURIComponent(
			organizationId
		)}&includeKeys=1`;
		const response = await fetch(url, {
			method: 'GET',
			headers: { Authorization: `Bearer ${this.apiKey}` },
		});
		if (!response.ok) {
			const body = await response.text().catch(() => 'Unknown error');
			throw new Error(`MTA credential list failed (${response.status}): ${body}`);
		}
		const decoded = decodeCredentialList(await response.json());
		if (!decoded.ok) {
			throw new Error(`MTA credential list returned an unexpected answer (${decoded.issue})`);
		}
		return decoded.value.credentials;
	}

	/**
	 * Overwrite one credential's `allowedDomains` (H2 verified-sending-domain set).
	 * Rewrites only that field on the MTA side; the MTA normalizes the list.
	 */
	async setCredentialAllowedDomains(apiKey: string, allowedDomains: string[]): Promise<void> {
		const response = await fetch(`${this.baseUrl}/credentials/${encodeURIComponent(apiKey)}`, {
			method: 'PATCH',
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ allowedDomains }),
		});
		if (!response.ok) {
			const body = await response.text().catch(() => 'Unknown error');
			throw new Error(`MTA credential update failed (${response.status}): ${body}`);
		}
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
