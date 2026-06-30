package com.owlat.sdk.model;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Cursor-based pagination parameters for list requests.
 *
 * <p>Pagination is cursor-based: pass the {@code cursor} from the previous
 * response's {@link PaginationMeta#getCursor()} to fetch the next page, and stop
 * once {@link PaginationMeta#isDone()} is true. There is no row ceiling — every
 * record is reachable.
 */
public class PaginationParams {

    private final Integer limit;
    private final String cursor;
    private final String search;

    private PaginationParams(Builder builder) {
        this.limit = builder.limit;
        this.cursor = builder.cursor;
        this.search = builder.search;
    }

    /** Page size, or {@code null} if unset (server default applies). */
    public Integer getLimit() {
        return limit;
    }

    /**
     * Opaque continuation cursor from a previous response, or {@code null} to
     * fetch the first page.
     */
    public String getCursor() {
        return cursor;
    }

    /** Search query, or {@code null} if unset. */
    public String getSearch() {
        return search;
    }

    public String toQueryString() {
        List<String> parts = new ArrayList<>();
        if (limit != null) {
            parts.add("limit=" + limit);
        }
        if (cursor != null) {
            parts.add("cursor=" + encode(cursor));
        }
        if (search != null) {
            parts.add("search=" + encode(search));
        }
        return parts.isEmpty() ? "" : "?" + String.join("&", parts);
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    public static Builder builder() {
        return new Builder();
    }

    public static class Builder {
        private Integer limit;
        private String cursor;
        private String search;

        /** Number of items per page (max 100). Defaults to 25. */
        public Builder limit(int limit) {
            this.limit = limit;
            return this;
        }

        /**
         * Opaque continuation cursor from a previous response's
         * {@link PaginationMeta#getCursor()}. Omit to fetch the first page.
         */
        public Builder cursor(String cursor) {
            this.cursor = cursor;
            return this;
        }

        /** Search query to filter results (relevance-ordered). */
        public Builder search(String search) {
            this.search = search;
            return this;
        }

        public PaginationParams build() {
            return new PaginationParams(this);
        }
    }
}
