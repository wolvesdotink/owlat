package com.owlat.sdk.resource;

import com.fasterxml.jackson.core.type.TypeReference;
import com.owlat.sdk.internal.HttpClient;
import com.owlat.sdk.model.ApiResponse;
import com.owlat.sdk.model.template.RenderParams;
import com.owlat.sdk.model.template.RenderResult;

/** Render block content without storing it. Needs the {@code templates:read} scope. */
public class RenderResource extends BaseResource {

    private static final String PATH = "/api/v1/render";

    public RenderResource(HttpClient httpClient) {
        super(httpClient);
    }

    /**
     * Render blocks as this instance would store them: the HTML, the text body
     * and the subject a save would produce, the issues the content check of a
     * write finds, each with its block, and a health score. With data
     * variables a transactional email is composed as a send composes it.
     * Nothing is stored.
     *
     * @throws com.owlat.sdk.exception.ValidationException with reason
     *         {@code invalid_content} when a block has an error a write would refuse
     */
    public RenderResult email(RenderParams params) {
        return httpClient.post(PATH, params, new TypeReference<ApiResponse<RenderResult>>() {}).getData();
    }
}
