package com.owlat.sdk.model.transactional;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Filters and page of {@code transactional().list()}. Filter by email or by
 * status, not both. The window is when the sends were queued: {@code until}
 * defaults to now and {@code since} to 30 days before it, and it can be at
 * most 30 days long.
 */
public class ListTransactionalSendsParams {

    private final String email;
    private final String status;
    private final String since;
    private final String until;
    private final Integer limit;
    private final String cursor;

    private ListTransactionalSendsParams(Builder builder) {
        this.email = builder.email;
        this.status = builder.status;
        this.since = builder.since;
        this.until = builder.until;
        this.limit = builder.limit;
        this.cursor = builder.cursor;
    }

    public String toQueryString() {
        List<String> parts = new ArrayList<>();
        add(parts, "email", email);
        add(parts, "status", status);
        add(parts, "since", since);
        add(parts, "until", until);
        if (limit != null) parts.add("limit=" + limit);
        add(parts, "cursor", cursor);
        return parts.isEmpty() ? "" : "?" + String.join("&", parts);
    }

    private static void add(List<String> parts, String name, String value) {
        if (value != null) parts.add(name + "=" + URLEncoder.encode(value, StandardCharsets.UTF_8));
    }

    public static Builder builder() {
        return new Builder();
    }

    public static class Builder {
        private String email;
        private String status;
        private String since;
        private String until;
        private Integer limit;
        private String cursor;

        /** Only sends to this address, matched after trimming and lowercasing. */
        public Builder email(String email) {
            this.email = email;
            return this;
        }

        /** Only sends in this delivery state, for example {@code failed} or {@code bounced}. */
        public Builder status(String status) {
            this.status = status;
            return this;
        }

        /** ISO 8601 timestamp: only sends queued at or after it. */
        public Builder since(String since) {
            this.since = since;
            return this;
        }

        /** ISO 8601 timestamp: only sends queued before it. */
        public Builder until(String until) {
            this.until = until;
            return this;
        }

        /** Items per page, at most 100. Defaults to 25. */
        public Builder limit(int limit) {
            this.limit = limit;
            return this;
        }

        /**
         * The previous page's cursor. Pass the same filters with it: a cursor
         * sent with other filters is refused.
         */
        public Builder cursor(String cursor) {
            this.cursor = cursor;
            return this;
        }

        public ListTransactionalSendsParams build() {
            return new ListTransactionalSendsParams(this);
        }
    }
}
