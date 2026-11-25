import { BaseResource } from './base';
import type { ApiResponse } from '../types/common';
import type { BrandKit, BrandKitInput } from '../types/brandKit';

const BASE_PATH = '/api/v1/brand-kit';

/**
 * Resource for the brand kit: the colours, fonts, button style and footer
 * every email starts from. Reads need the `brand-kit:read` scope, writes
 * `brand-kit:write`.
 */
export class BrandKitResource extends BaseResource {
	/** Get the brand kit, as the brand kit page shows it. */
	async get(): Promise<BrandKit> {
		const response = await this.http.get<ApiResponse<BrandKit>>(BASE_PATH);
		return response.data.data;
	}

	/**
	 * Change the fields `params` names; a field left out keeps its stored value.
	 * Returns the whole kit as stored. The logos cannot be changed here.
	 *
	 * @throws {ValidationError} If a value is refused; `data.field` names the field
	 */
	async update(params: BrandKitInput): Promise<BrandKit> {
		const response = await this.http.put<ApiResponse<BrandKit>>(BASE_PATH, params);
		return response.data.data;
	}
}
