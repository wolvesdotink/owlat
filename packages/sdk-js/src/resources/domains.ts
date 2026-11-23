import { BaseResource } from './base';
import type { ApiResponse } from '../types/common';
import type { SendingDomainSetup } from '../types/domains';

/**
 * Resource for reading the instance's sending domains.
 */
export class DomainsResource extends BaseResource {
	/**
	 * List every sending domain with its verification state and each DNS
	 * record it needs: the full name, the value to publish, and what the last
	 * check found there (`found`, `wrong`, `missing` or `unchecked`). Needs the
	 * `status:read` scope. Every member of the workspace sees the same records
	 * on the Domains page.
	 *
	 * The states come from the last check, at `lastCheckedAt`. Owlat re-checks
	 * verified domains daily; a domain still being set up is checked while its
	 * Domains page is open.
	 *
	 * @returns Every sending domain
	 * @throws {ForbiddenError} If the key lacks the `status:read` scope
	 *
	 * @example
	 * ```typescript
	 * for (const domain of await owlat.domains.list()) {
	 *   for (const record of domain.records.filter((r) => r.state !== 'found')) {
	 *     console.log(domain.domain, record.type, record.host, record.value, record.state);
	 *   }
	 * }
	 * ```
	 */
	async list(): Promise<SendingDomainSetup[]> {
		const response = await this.http.get<ApiResponse<SendingDomainSetup[]>>('/api/v1/domains');
		return response.data.data;
	}
}
