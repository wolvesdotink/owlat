import { BaseResource } from './base';
import type { ApiResponse } from '../types/common';
import type { DomainCheckRequest, SendingDomainSetup } from '../types/domains';

/**
 * Resource for the instance's sending domains: read them, and ask for a fresh
 * check of one.
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
	 * Domains page is open, or when {@link verify} asks for it.
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

	/**
	 * Ask for a fresh DNS check of one sending domain, for example right after
	 * publishing its records. The check runs in the background: poll
	 * {@link list} until the domain's `lastCheckedAt` is at or after the
	 * returned `requestedAt`. One check per domain per minute; a second one
	 * sooner is refused with `retryAfter`. Needs the `domains:verify` scope.
	 *
	 * @param domain - The domain name, or its `id` from {@link list}
	 * @returns The domain as it stood before the check, and when the check was asked for
	 * @throws {NotFoundError} If no sending domain has that name or id
	 * @throws {RateLimitError} If the domain was checked less than a minute ago
	 *
	 * @example
	 * ```typescript
	 * const { requestedAt } = await owlat.domains.verify('news.example.com');
	 * ```
	 */
	async verify(domain: string): Promise<DomainCheckRequest> {
		const response = await this.http.post<ApiResponse<DomainCheckRequest>>(
			`/api/v1/domains/${encodeURIComponent(domain)}/verify`
		);
		return response.data.data;
	}
}
