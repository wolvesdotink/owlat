package com.owlat.sdk.resource;

import com.fasterxml.jackson.core.type.TypeReference;
import com.owlat.sdk.internal.HttpClient;
import com.owlat.sdk.model.ApiResponse;
import com.owlat.sdk.model.limits.SendLimits;

public class LimitsResource extends BaseResource {

    private static final String BASE_PATH = "/api/v1/limits";

    public LimitsResource(HttpClient httpClient) {
        super(httpClient);
    }

    /**
     * The transactional send limits in force, and what is left of this key's
     * daily limit until the next UTC midnight. Any key may read its own; the
     * read spends no send.
     */
    public SendLimits get() {
        return httpClient.get(BASE_PATH, new TypeReference<ApiResponse<SendLimits>>() {}).getData();
    }
}
