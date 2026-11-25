package com.owlat.sdk.resource;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonUnwrapped;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.owlat.sdk.RequestOptions;
import com.owlat.sdk.exception.OwlatException;
import com.owlat.sdk.internal.HttpClient;
import com.owlat.sdk.internal.JsonMapper;
import com.owlat.sdk.model.ApiResponse;
import com.owlat.sdk.model.CursorPaginatedResponse;
import com.owlat.sdk.model.transactional.ListTransactionalSendsParams;
import com.owlat.sdk.model.transactional.SendTransactionalDryRun;
import com.owlat.sdk.model.transactional.SendTransactionalParams;
import com.owlat.sdk.model.transactional.SendTransactionalResponse;
import com.owlat.sdk.model.transactional.TransactionalSendStatus;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

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

    /**
     * Send with per-call options. With {@link RequestOptions#idempotencyKey(String)}
     * the server applies the request at most once per key, and the SDK retries
     * it after a 5xx, network error or timeout.
     *
     * @throws com.owlat.sdk.exception.ConflictException if the key was already
     *         used for a different request
     */
    public SendTransactionalResponse send(SendTransactionalParams params, RequestOptions options) {
        return httpClient
                .post(BASE_PATH, params, new TypeReference<ApiResponse<SendTransactionalResponse>>() {}, options)
                .getData();
    }

    /**
     * Compose a transactional email for one recipient and answer what a send
     * of the same parameters would do, without sending: the subject, HTML and
     * text a send would deliver, and the refusal it would meet now. Nothing is
     * sent, stored or counted against a limit, and no idempotency key is used.
     * A draft is composed too when the key also has {@code templates:read}.
     * Needs the {@code transactional:send} scope.
     *
     * @throws OwlatException with code {@code dry_run_unsupported} if the server
     *         answered with a queued send: an instance older than the dry run
     *         ignores the flag and sends the email
     */
    public SendTransactionalDryRun dryRun(SendTransactionalParams params) {
        JsonNode data = httpClient
                .post(BASE_PATH, new DryRunRequest(params), new TypeReference<ApiResponse<JsonNode>>() {})
                .getData();
        if (data == null || !data.path("dryRun").asBoolean(false)) {
            throw new OwlatException(
                    "The server queued the email instead of a dry run: it is older than the dry run and ignored the flag.",
                    "dry_run_unsupported", 202, null);
        }
        try {
            return JsonMapper.instance().treeToValue(data, SendTransactionalDryRun.class);
        } catch (JsonProcessingException e) {
            throw new OwlatException("Unexpected dry-run response: " + e.getOriginalMessage(),
                    "parse_error", 200, null, e);
        }
    }

    /** A send request with {@code dryRun: true} added. */
    private static final class DryRunRequest {
        private final SendTransactionalParams params;

        DryRunRequest(SendTransactionalParams params) {
            this.params = params;
        }

        @JsonUnwrapped
        public SendTransactionalParams getParams() {
            return params;
        }

        @JsonProperty("dryRun")
        public boolean isDryRun() {
            return true;
        }
    }

    /**
     * Where one send stands. Needs the {@code transactional:send} scope.
     *
     * @param sendId the {@link SendTransactionalResponse#getTransactionalEmailId()}
     *        the send call returned
     * @throws com.owlat.sdk.exception.NotFoundException if no send created
     *         through this API has that id
     */
    public TransactionalSendStatus get(String sendId) {
        return httpClient
                .get(BASE_PATH + "/" + URLEncoder.encode(sendId, StandardCharsets.UTF_8),
                        new TypeReference<ApiResponse<TransactionalSendStatus>>() {})
                .getData();
    }

    /** The first page of the last 30 days' sends. */
    public CursorPaginatedResponse<TransactionalSendStatus> list() {
        return list(null);
    }

    /**
     * List the sends this API created, newest first, each as {@link #get}
     * answers it: the sends to one address, in one state, or both, within a
     * window of at most 30 days. Needs the {@code transactional:send} scope.
     *
     * <p>Pass the {@code cursor} from the previous response's
     * {@link com.owlat.sdk.model.CursorPaginationMeta#getCursor()}, with the
     * same filters, to fetch the next page, and stop once
     * {@link com.owlat.sdk.model.CursorPaginationMeta#isDone()} is true.
     *
     * @throws com.owlat.sdk.exception.ValidationException if a filter is
     *         malformed, the window is over 30 days, or the cursor belongs to
     *         other filters
     */
    public CursorPaginatedResponse<TransactionalSendStatus> list(ListTransactionalSendsParams params) {
        String path = BASE_PATH + (params == null ? "" : params.toQueryString());
        return httpClient.get(path, new TypeReference<CursorPaginatedResponse<TransactionalSendStatus>>() {});
    }
}
