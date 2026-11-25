import { BaseResource } from './base';
import type { ApiResponse } from '../types/common';
import type { RenderRequest, RenderResult } from '../types/templates';

/**
 * Resource for rendering block content without storing it. Needs the
 * `templates:read` scope.
 */
export class RenderResource extends BaseResource {
	/**
	 * Render blocks as this instance would store them: the HTML, the text body
	 * and the subject a save would produce, the issues the content check of a
	 * write finds, each with its block, and a health score. With
	 * `dataVariables` a transactional email is composed as a send composes it,
	 * and `sendRefusal` says what a send with that data would be refused for.
	 * Nothing is stored.
	 *
	 * @throws {ValidationError} With reason `invalid_content` when a block has
	 *   an error a write would refuse; `data.issues` names each block at fault
	 *
	 * @example
	 * ```typescript
	 * const { html, issues } = await owlat.render.email({
	 *   subject: 'Your order {{orderNumber}}',
	 *   blocks,
	 *   dataVariables: { orderNumber: 'A-1001' },
	 * });
	 * ```
	 */
	async email(request: RenderRequest): Promise<RenderResult> {
		const response = await this.http.post<ApiResponse<RenderResult>>('/api/v1/render', request);
		return response.data.data;
	}
}
