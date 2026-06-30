package com.owlat.sdk.resource;

import com.fasterxml.jackson.core.type.TypeReference;
import com.owlat.sdk.internal.HttpClient;
import com.owlat.sdk.model.ApiResponse;
import com.owlat.sdk.model.topic.AddToTopicParams;
import com.owlat.sdk.model.topic.AddToTopicResponse;
import com.owlat.sdk.model.topic.RemoveFromTopicParams;
import com.owlat.sdk.model.topic.RemoveFromTopicResponse;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

public class TopicsResource extends BaseResource {

    private static final String BASE_PATH = "/api/v1/topics";

    public TopicsResource(HttpClient httpClient) {
        super(httpClient);
    }

    /**
     * URL-encode a path parameter (handles emails with + and other special chars).
     */
    private static String encodePath(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    public AddToTopicResponse addContact(AddToTopicParams params) {
        String path = BASE_PATH + "/" + encodePath(params.getTopicId()) + "/contacts";
        return httpClient
                .post(path, params, new TypeReference<ApiResponse<AddToTopicResponse>>() {})
                .getData();
    }

    public RemoveFromTopicResponse removeContact(RemoveFromTopicParams params) {
        String path = BASE_PATH + "/" + encodePath(params.getTopicId())
                + "/contacts/" + encodePath(params.getEmailOrId());
        return httpClient
                .delete(path, new TypeReference<ApiResponse<RemoveFromTopicResponse>>() {})
                .getData();
    }
}
