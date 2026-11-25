import { BaseResource } from './base';
import type { ApiResponse } from '../types/common';
import type { GetLimitsParams, SendLimits } from '../types/limits';

/**
 * Resource for reading the send limits that apply to this key.
 */
export class LimitsResource extends BaseResource {
	/**
	 * Get the transactional send limits in force and what is left of this
	 * key's daily limit: how many sends it has made today, how many it may
	 * still make, and when the count starts again (the next UTC midnight). Any
	 * key may read its own; the read sends nothing and spends no send.
	 *
	 * The per-recipient limit counts per template and address. Pass both to
	 * read that pair's count in `recipientSends.usage`; this needs the
	 * `transactional:send` scope.
	 *
	 * @param params - The template and address whose per-recipient count to read
	 * @returns The limits in force
	 * @throws {ValidationError} If the address is malformed or the template is missing
	 * @throws {NotFoundError} If no template has that ID or slug
	 *
	 * @example
	 * ```typescript
	 * const { dailySends } = await owlat.limits.get();
	 * if (dailySends.remaining !== null && dailySends.remaining < batch.length) {
	 *   console.warn(`Only ${dailySends.remaining} sends left until ${dailySends.resetsAt}`);
	 * }
	 *
	 * // May this password reset go out to Ada now?
	 * const { recipientSends } = await owlat.limits.get({
	 *   email: 'ada@example.com',
	 *   slug: 'password-reset',
	 * });
	 * if (recipientSends.usage?.remaining === 0) {
	 *   console.warn(`Try again after ${recipientSends.usage.resetsAt}`);
	 * }
	 * ```
	 */
	async get(params?: GetLimitsParams): Promise<SendLimits> {
		const searchParams = new URLSearchParams();
		if (params) {
			// Sent as given, empty included, for the server to refuse.
			searchParams.set('email', params.email);
			if (params.transactionalId !== undefined) {
				searchParams.set('transactionalId', params.transactionalId);
			}
			if (params.slug !== undefined) searchParams.set('slug', params.slug);
		}
		const queryString = searchParams.toString();
		const response = await this.http.get<ApiResponse<SendLimits>>(
			queryString ? `/api/v1/limits?${queryString}` : '/api/v1/limits'
		);
		return response.data.data;
	}
}
