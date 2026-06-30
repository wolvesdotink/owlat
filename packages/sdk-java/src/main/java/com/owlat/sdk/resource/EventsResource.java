package com.owlat.sdk.resource;

import com.fasterxml.jackson.core.type.TypeReference;
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
}
