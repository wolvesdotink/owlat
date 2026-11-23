package com.owlat.sdk.resource;

import com.fasterxml.jackson.core.type.TypeReference;
import com.owlat.sdk.internal.HttpClient;
import com.owlat.sdk.model.ApiResponse;
import com.owlat.sdk.model.PaginatedResponse;
import com.owlat.sdk.model.PaginationParams;
import com.owlat.sdk.model.topic.AddToTopicParams;
import com.owlat.sdk.model.topic.AddToTopicResponse;
import com.owlat.sdk.model.topic.RemoveFromTopicParams;
import com.owlat.sdk.model.topic.RemoveFromTopicResponse;
import com.owlat.sdk.model.topic.Topic;

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

    /** The first page of topics. */
    public PaginatedResponse<Topic> list() {
        return list(null);
    }

    /**
     * List the topics contacts can be subscribed to, oldest first, a page at a
     * time. Each topic's {@link Topic#getId() id} is the topic ID that
     * {@link #addContact} and {@link #removeContact} take. Needs the
     * {@code topics:read} scope.
     *
     * <p>Pass the {@code cursor} from the previous response's
     * {@link com.owlat.sdk.model.PaginationMeta#getCursor()} to fetch the next
     * page, and stop once {@link com.owlat.sdk.model.PaginationMeta#isDone()}
     * is true. Topics have no search: a {@code search} is answered with
     * {@code 400}.
     *
     * @throws com.owlat.sdk.exception.ForbiddenException if the key lacks
     *         the {@code topics:read} scope
     */
    public PaginatedResponse<Topic> list(PaginationParams params) {
        String path = BASE_PATH + (params == null ? "" : params.toQueryString());
        return httpClient.get(path, new TypeReference<PaginatedResponse<Topic>>() {});
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
