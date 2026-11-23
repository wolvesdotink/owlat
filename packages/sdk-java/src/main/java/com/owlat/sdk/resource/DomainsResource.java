package com.owlat.sdk.resource;

import com.fasterxml.jackson.core.type.TypeReference;
import com.owlat.sdk.internal.HttpClient;
import com.owlat.sdk.model.ApiResponse;
import com.owlat.sdk.model.domain.SendingDomainSetup;

import java.util.List;

public class DomainsResource extends BaseResource {

    private static final String BASE_PATH = "/api/v1/domains";

    public DomainsResource(HttpClient httpClient) {
        super(httpClient);
    }

    /**
     * Every sending domain with its verification state and each DNS record it
     * needs: the full name, the value to publish and what the last check found.
     * Needs the {@code status:read} scope.
     *
     * @throws com.owlat.sdk.exception.ForbiddenException if the key lacks
     *         the {@code status:read} scope
     */
    public List<SendingDomainSetup> list() {
        return httpClient.get(BASE_PATH, new TypeReference<ApiResponse<List<SendingDomainSetup>>>() {}).getData();
    }
}
