package com.owlat.sdk.resource;

import com.fasterxml.jackson.core.type.TypeReference;
import com.owlat.sdk.internal.HttpClient;
import com.owlat.sdk.model.ApiResponse;
import com.owlat.sdk.model.limits.GetLimitsParams;
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
        return get(null);
    }

    /**
     * The limits as {@link #get()} reads them, plus the per-recipient count of
     * one template and one address in
     * {@code getRecipientSends().getUsage()}. Naming a pair needs the
     * {@code transactional:send} scope.
     *
     * @throws com.owlat.sdk.exception.ValidationException if the address is
     *         malformed or the template is missing
     * @throws com.owlat.sdk.exception.NotFoundException if no template has that
     *         ID or slug
     */
    public SendLimits get(GetLimitsParams params) {
        String path = BASE_PATH + (params == null ? "" : params.toQueryString());
        return httpClient.get(path, new TypeReference<ApiResponse<SendLimits>>() {}).getData();
    }
}
