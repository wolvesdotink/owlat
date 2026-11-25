package com.owlat.sdk.model.limits;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * The template and address of {@code limits().get(params)} whose
 * per-recipient count to read. Name the template by ID or by slug, as in a
 * send.
 */
public class GetLimitsParams {

    private final String email;
    private final String transactionalId;
    private final String slug;

    private GetLimitsParams(String email, String transactionalId, String slug) {
        this.email = email;
        this.transactionalId = transactionalId;
        this.slug = slug;
    }

    /** The count of the template with this slug to {@code email}. */
    public static GetLimitsParams bySlug(String email, String slug) {
        return new GetLimitsParams(email, null, slug);
    }

    /** The count of the template with this ID to {@code email}. */
    public static GetLimitsParams byTransactionalId(String email, String transactionalId) {
        return new GetLimitsParams(email, transactionalId, null);
    }

    public String toQueryString() {
        List<String> parts = new ArrayList<>();
        add(parts, "email", email);
        add(parts, "transactionalId", transactionalId);
        add(parts, "slug", slug);
        return parts.isEmpty() ? "" : "?" + String.join("&", parts);
    }

    private static void add(List<String> parts, String name, String value) {
        if (value != null) parts.add(name + "=" + URLEncoder.encode(value, StandardCharsets.UTF_8));
    }
}
