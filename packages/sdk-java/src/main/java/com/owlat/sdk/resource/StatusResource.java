package com.owlat.sdk.resource;

import com.fasterxml.jackson.core.type.TypeReference;
import com.owlat.sdk.internal.HttpClient;
import com.owlat.sdk.model.ApiResponse;
import com.owlat.sdk.model.status.DeliveryStatus;

public class StatusResource extends BaseResource {

    private static final String BASE_PATH = "/api/v1/status";

    public StatusResource(HttpClient httpClient) {
        super(httpClient);
    }

    /**
     * Whether the instance can send and, if not, why and what fixes it. Needs
     * the {@code status:read} scope.
     *
     * @throws com.owlat.sdk.exception.ForbiddenException if the key lacks
     *         the {@code status:read} scope
     */
    public DeliveryStatus get() {
        return httpClient.get(BASE_PATH, new TypeReference<ApiResponse<DeliveryStatus>>() {}).getData();
    }
}
