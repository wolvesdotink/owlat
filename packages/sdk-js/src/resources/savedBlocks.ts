import { BaseResource } from './base';
import type { ApiResponse, CursorPaginatedResponse } from '../types/common';
import type {
	ListTemplatesParams,
	SavedBlock,
	SavedBlockInput,
	SavedBlockSummary,
	SavedBlockWriteResult,
} from '../types/templates';

const BASE_PATH = '/api/v1/saved-blocks';

/**
 * Resource for reading and writing saved blocks, the reusable blocks emails
 * link to. Reads need the `templates:read` scope, writes `templates:write`.
 */
export class SavedBlocksResource extends BaseResource {
	/** List the saved blocks, oldest first, a page at a time, without their content. */
	async list(params?: ListTemplatesParams): Promise<CursorPaginatedResponse<SavedBlockSummary>> {
		const searchParams = new URLSearchParams();
		if (params?.limit) searchParams.set('limit', String(params.limit));
		if (params?.cursor) searchParams.set('cursor', params.cursor);
		const queryString = searchParams.toString();
		const response = await this.http.get<CursorPaginatedResponse<SavedBlockSummary>>(
			queryString ? `${BASE_PATH}?${queryString}` : BASE_PATH
		);
		return response.data;
	}

	/**
	 * Get a saved block with its blocks.
	 *
	 * @throws {NotFoundError} If no saved block has the ID
	 */
	async get(id: string): Promise<SavedBlock> {
		const response = await this.http.get<ApiResponse<SavedBlock>>(
			`${BASE_PATH}/${encodeURIComponent(id)}`
		);
		return response.data.data;
	}

	/** Create a saved block. */
	async create(params: SavedBlockInput): Promise<SavedBlockWriteResult> {
		const response = await this.http.post<ApiResponse<SavedBlockWriteResult>>(BASE_PATH, params);
		return response.data.data;
	}

	/**
	 * Replace a saved block's name, description and blocks. A content change
	 * reaches every email that links the block, as an edit in the editor does.
	 */
	async update(id: string, params: SavedBlockInput): Promise<SavedBlockWriteResult> {
		const response = await this.http.put<ApiResponse<SavedBlockWriteResult>>(
			`${BASE_PATH}/${encodeURIComponent(id)}`,
			params
		);
		return response.data.data;
	}
}
