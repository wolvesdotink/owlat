import { BaseResource } from './base';
import type { SendEventParams, SendEventResponse } from '../types/events';
import type { ApiResponse, RequestOptions } from '../types/common';

/**
 * Resource for sending events to trigger automations.
 */
export class EventsResource extends BaseResource {
	/**
	 * Send an event for a contact.
	 *
	 * Events can trigger automations based on your workflow configuration.
	 * Use them to track user actions like purchases, signups, or custom events.
	 *
	 * @param params - Event parameters
	 * @param options - Per-call options; `idempotencyKey` makes the send safe to
	 *   retry (see {@link RequestOptions})
	 * @returns Response with event ID and triggered automation count
	 * @throws {NotFoundError} If contact not found and createContactIfNotExists is false
	 * @throws {ValidationError} If event name format is invalid
	 * @throws {ConflictError} If `idempotencyKey` was already used for a different request
	 *
	 * @example
	 * ```typescript
	 * const result = await owlat.events.send({
	 *   email: 'user@example.com',
	 *   eventName: 'purchase_completed',
	 *   eventProperties: {
	 *     orderId: 'order_123',
	 *     amount: 99.99,
	 *     productName: 'Premium Plan',
	 *   },
	 *   createContactIfNotExists: true,
	 * });
	 *
	 * console.log(`Triggered ${result.triggeredAutomations} automations`);
	 * ```
	 */
	async send(params: SendEventParams, options?: RequestOptions): Promise<SendEventResponse> {
		const response = await this.http.post<ApiResponse<SendEventResponse>>(
			'/api/v1/events',
			params,
			undefined,
			options
		);
		return response.data.data;
	}
}
