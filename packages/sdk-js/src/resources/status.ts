import { BaseResource } from './base';
import type { ApiResponse } from '../types/common';
import type { DeliveryStatus } from '../types/status';

/**
 * Resource for reading whether the instance can send.
 */
export class StatusResource extends BaseResource {
	/**
	 * Get whether the instance can send and, if not, why and what fixes it:
	 * the worst problem as a stable `reasonCode` with an English explanation
	 * and where the fix is made, each sending domain's verification state, the
	 * 30-day bounce and complaint rates against their limits, and a suspension
	 * or ban in force. Needs the `status:read` scope. Every member of the
	 * workspace sees the same facts in the web app.
	 *
	 * @returns How sending stands
	 * @throws {ForbiddenError} If the key lacks the `status:read` scope
	 *
	 * @example
	 * ```typescript
	 * const status = await owlat.status.get();
	 * if (status.level === 'error') {
	 *   console.warn(status.reasonCode, status.explanation, status.fix?.route);
	 * }
	 * ```
	 */
	async get(): Promise<DeliveryStatus> {
		const response = await this.http.get<ApiResponse<DeliveryStatus>>('/api/v1/status');
		return response.data.data;
	}
}
