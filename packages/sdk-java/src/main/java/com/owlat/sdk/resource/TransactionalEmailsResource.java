package com.owlat.sdk.resource;

import com.fasterxml.jackson.core.type.TypeReference;
import com.owlat.sdk.internal.HttpClient;
import com.owlat.sdk.internal.HttpMethod;
import com.owlat.sdk.model.ApiResponse;
import com.owlat.sdk.model.CursorPaginatedResponse;
import com.owlat.sdk.model.PaginationParams;
import com.owlat.sdk.model.template.TransactionalEmail;
import com.owlat.sdk.model.template.TransactionalEmailInput;
import com.owlat.sdk.model.template.TransactionalEmailSummary;
import com.owlat.sdk.model.template.TransactionalEmailWriteOptions;
import com.owlat.sdk.model.template.TransactionalEmailWriteResult;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * Read and write transactional emails: their blocks, translations and
 * variable schema, and whether they are published. Reads need the
 * {@code templates:read} scope, writes and publishing {@code templates:write}.
 *
 * <p>A write is checked, sanitised, rendered and scanned as an edit in the
 * editor is. Its result lists what the content check found; a block with an
 * error is refused with a {@code ValidationException} (reason
 * {@code invalid_content}) whose data names the block.
 */
public class TransactionalEmailsResource extends BaseResource {

    private static final String BASE_PATH = "/api/v1/transactional-emails";

    public TransactionalEmailsResource(HttpClient httpClient) {
        super(httpClient);
    }

    private static String emailPath(String slug) {
        return BASE_PATH + "/" + URLEncoder.encode(slug, StandardCharsets.UTF_8).replace("+", "%20");
    }

    private static String revisionHeader(TransactionalEmailWriteOptions options) {
        return options == null || options.getIfRevision() == null
                ? null
                : "\"" + options.getIfRevision() + "\"";
    }

    /** The first page of transactional emails. */
    public CursorPaginatedResponse<TransactionalEmailSummary> list() {
        return list(null);
    }

    /**
     * List the transactional emails, oldest first, a page at a time, without
     * their content. A {@code search} is answered with {@code 400}.
     */
    public CursorPaginatedResponse<TransactionalEmailSummary> list(PaginationParams params) {
        String path = BASE_PATH + (params == null ? "" : params.toQueryString());
        return httpClient.get(path,
                new TypeReference<CursorPaginatedResponse<TransactionalEmailSummary>>() {});
    }

    /**
     * Get a transactional email by slug, with its content. Its
     * {@link TransactionalEmail#toInput()} is what {@link #upsert} accepts, so
     * this is also the export.
     *
     * @throws com.owlat.sdk.exception.NotFoundException if no email has the slug
     */
    public TransactionalEmail get(String slug) {
        return httpClient.get(emailPath(slug), new TypeReference<ApiResponse<TransactionalEmail>>() {})
                .getData();
    }

    /**
     * Create a transactional email as a draft. The input needs a slug.
     *
     * @throws com.owlat.sdk.exception.ConflictException if another email has the slug
     */
    public TransactionalEmailWriteResult create(TransactionalEmailInput input) {
        return httpClient.post(BASE_PATH, input,
                new TypeReference<ApiResponse<TransactionalEmailWriteResult>>() {}).getData();
    }

    /** {@link #upsert(String, TransactionalEmailInput, TransactionalEmailWriteOptions)} without options. */
    public TransactionalEmailWriteResult upsert(String slug, TransactionalEmailInput input) {
        return upsert(slug, input, null);
    }

    /**
     * Create the email with this slug, or replace its editable fields. A field
     * left out takes its default. This is the import.
     *
     * @throws com.owlat.sdk.exception.ConflictException if the revision in the
     *         options is no longer current
     * @throws com.owlat.sdk.exception.InvalidStateException if the email is
     *         published and the options do not say {@code whilePublished}
     */
    public TransactionalEmailWriteResult upsert(String slug, TransactionalEmailInput input,
                                                TransactionalEmailWriteOptions options) {
        String path = emailPath(slug)
                + (options != null && options.isWhilePublished() ? "?whilePublished=true" : "");
        return httpClient.conditional(HttpMethod.PUT, path, input,
                new TypeReference<ApiResponse<TransactionalEmailWriteResult>>() {},
                revisionHeader(options)).getData();
    }

    /** {@link #publish(String, TransactionalEmailWriteOptions)} without a revision check. */
    public TransactionalEmail publish(String slug) {
        return publish(slug, null);
    }

    /**
     * Publish an email so sends can use it. The content scan runs first:
     * suspicious content comes back as {@code pending_review}, blocked content
     * is refused (reason {@code content_blocked}). Publishing a published
     * email changes nothing.
     */
    public TransactionalEmail publish(String slug, TransactionalEmailWriteOptions options) {
        return httpClient.conditional(HttpMethod.POST, emailPath(slug) + "/publish", null,
                new TypeReference<ApiResponse<TransactionalEmail>>() {},
                revisionHeader(options)).getData();
    }

    /** Return an email to draft, so sends that name it are refused. */
    public TransactionalEmail unpublish(String slug) {
        return httpClient.post(emailPath(slug) + "/unpublish", null,
                new TypeReference<ApiResponse<TransactionalEmail>>() {}).getData();
    }
}
