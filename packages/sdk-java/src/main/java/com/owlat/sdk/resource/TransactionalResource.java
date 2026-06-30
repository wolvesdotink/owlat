package com.owlat.sdk.resource;

import com.fasterxml.jackson.core.type.TypeReference;
import com.owlat.sdk.internal.HttpClient;
import com.owlat.sdk.model.ApiResponse;
import com.owlat.sdk.model.transactional.SendTransactionalParams;
import com.owlat.sdk.model.transactional.SendTransactionalResponse;

public class TransactionalResource extends BaseResource {

    private static final String BASE_PATH = "/api/v1/transactional";

    public TransactionalResource(HttpClient httpClient) {
        super(httpClient);
    }

    public SendTransactionalResponse send(SendTransactionalParams params) {
        return httpClient
                .post(BASE_PATH, params, new TypeReference<ApiResponse<SendTransactionalResponse>>() {})
                .getData();
    }
}
