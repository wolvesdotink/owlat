package com.owlat.sdk.resource;

import com.fasterxml.jackson.core.type.TypeReference;
import com.owlat.sdk.internal.HttpClient;
import com.owlat.sdk.model.ApiResponse;
import com.owlat.sdk.model.CursorPaginatedResponse;
import com.owlat.sdk.model.PaginationParams;
import com.owlat.sdk.model.template.SavedBlock;
import com.owlat.sdk.model.template.SavedBlockInput;
import com.owlat.sdk.model.template.SavedBlockSummary;
import com.owlat.sdk.model.template.SavedBlockWriteResult;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * Read and write saved blocks, the reusable blocks emails link to. Reads need
 * the {@code templates:read} scope, writes {@code templates:write}.
 */
public class SavedBlocksResource extends BaseResource {

    private static final String BASE_PATH = "/api/v1/saved-blocks";

    public SavedBlocksResource(HttpClient httpClient) {
        super(httpClient);
    }

    private static String blockPath(String id) {
        return BASE_PATH + "/" + URLEncoder.encode(id, StandardCharsets.UTF_8);
    }

    /** The first page of saved blocks. */
    public CursorPaginatedResponse<SavedBlockSummary> list() {
        return list(null);
    }

    /** List the saved blocks, oldest first, a page at a time, without their content. */
    public CursorPaginatedResponse<SavedBlockSummary> list(PaginationParams params) {
        String path = BASE_PATH + (params == null ? "" : params.toQueryString());
        return httpClient.get(path, new TypeReference<CursorPaginatedResponse<SavedBlockSummary>>() {});
    }

    /**
     * Get a saved block with its blocks.
     *
     * @throws com.owlat.sdk.exception.NotFoundException if no saved block has the ID
     */
    public SavedBlock get(String id) {
        return httpClient.get(blockPath(id), new TypeReference<ApiResponse<SavedBlock>>() {}).getData();
    }

    /** Create a saved block. */
    public SavedBlockWriteResult create(SavedBlockInput input) {
        return httpClient.post(BASE_PATH, input,
                new TypeReference<ApiResponse<SavedBlockWriteResult>>() {}).getData();
    }

    /**
     * Replace a saved block's name, description and blocks. A content change
     * reaches every email that links the block, as an edit in the editor does.
     */
    public SavedBlockWriteResult update(String id, SavedBlockInput input) {
        return httpClient.put(blockPath(id), input,
                new TypeReference<ApiResponse<SavedBlockWriteResult>>() {}).getData();
    }
}
