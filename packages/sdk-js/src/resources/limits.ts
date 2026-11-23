import { BaseResource } from './base';
import type { ApiResponse } from '../types/common';
import type { SendLimits } from '../types/limits';

/**
 * Resource for reading the send limits that apply to this key.
 */
export class LimitsResource extends BaseResource {
	/**
	 * Get the transactional send limits in force and what is left of this
	 * key's daily limit: how many sends it has made today, how many it may
	 * still make, and when the count starts again (the next UTC midnight). The
	 * per-recipient limit counts per template and address, so it comes with
	 * its size and window only. Any key may read its own; the read sends
	 * nothing and spends no send.
	 *
	 * @returns The limits in force
	 *
	 * @example
	 * ```typescript
	 * const { dailySends } = await owlat.limits.get();
	 * if (dailySends.remaining !== null && dailySends.remaining < batch.length) {
	 *   console.warn(`Only ${dailySends.remaining} sends left until ${dailySends.resetsAt}`);
	 * }
	 * ```
	 */
	async get(): Promise<SendLimits> {
		const response = await this.http.get<ApiResponse<SendLimits>>('/api/v1/limits');
		return response.data.data;
	}
}
