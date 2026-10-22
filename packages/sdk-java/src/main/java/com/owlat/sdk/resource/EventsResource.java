package com.owlat.sdk.resource;

import com.fasterxml.jackson.core.type.TypeReference;
import com.owlat.sdk.RequestOptions;
import com.owlat.sdk.internal.HttpClient;
import com.owlat.sdk.model.ApiResponse;
import com.owlat.sdk.model.event.SendEventParams;
import com.owlat.sdk.model.event.SendEventResponse;

public class EventsResource extends BaseResource {

    private static final String BASE_PATH = "/api/v1/events";

    public EventsResource(HttpClient httpClient) {
        super(httpClient);
    }

    public SendEventResponse send(SendEventParams params) {
        return httpClient
                .post(BASE_PATH, params, new TypeReference<ApiResponse<SendEventResponse>>() {})
                .getData();
    }

    /**
     * Send with per-call options. With {@link RequestOptions#idempotencyKey(String)}
     * the server applies the request at most once per key, and the SDK retries
     * it after a 5xx, network error or timeout.
     *
     * @throws com.owlat.sdk.exception.ConflictException if the key was already
     *         used for a different request
     */
    public SendEventResponse send(SendEventParams params, RequestOptions options) {
        return httpClient
                .post(BASE_PATH, params, new TypeReference<ApiResponse<SendEventResponse>>() {}, options)
                .getData();
    }
}
