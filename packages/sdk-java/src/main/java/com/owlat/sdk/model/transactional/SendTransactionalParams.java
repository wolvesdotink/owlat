package com.owlat.sdk.model.transactional;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

public class SendTransactionalParams {

    private final String email;
    private final String transactionalId;
    private final String slug;
    private final Map<String, Object> dataVariables;
    private final String language;
    private final List<TransactionalAttachment> attachments;

    private SendTransactionalParams(Builder builder) {
        this.email = builder.email;
        this.transactionalId = builder.transactionalId;
        this.slug = builder.slug;
        this.dataVariables = builder.dataVariables;
        this.language = builder.language;
        this.attachments = builder.attachments;
    }

    public String getEmail() {
        return email;
    }

    public String getTransactionalId() {
        return transactionalId;
    }

    public String getSlug() {
        return slug;
    }

    /**
     * Template data variables, keyed by variable name. Values may be any
     * JSON primitive supported by the template engine: {@link String},
     * {@link Number} (e.g. {@link Integer}, {@link Long}, {@link Double}),
     * or {@link Boolean}. Jackson serializes each value as the matching JSON
     * primitive, so a numeric or boolean variable is sent as a JSON
     * number/boolean rather than a quoted string.
     */
    public Map<String, Object> getDataVariables() {
        return dataVariables;
    }

    public String getLanguage() {
        return language;
    }

    public List<TransactionalAttachment> getAttachments() {
        return attachments;
    }

    public static Builder builder(String email) {
        return new Builder(email);
    }

    public static class Builder {

        /**
         * Content types that must never be sent as attachments. Mirrors the JS
         * SDK guard (packages/sdk-js src/resources/transactional.ts). Matched
         * case-insensitively against the attachment's content type.
         */
        private static final Set<String> DANGEROUS_MIME_TYPES = Set.of(
                "application/x-msdownload",
                "application/x-executable",
                "application/x-msdos-program",
                "application/x-sh",
                "application/x-bat",
                "application/x-cmd"
        );

        /**
         * Standard base64 alphabet, allowing up to two trailing {@code =} pad
         * characters. Mirrors the JS SDK regex so a payload the JS caller would
         * reject cannot slip through the Java caller.
         */
        private static final Pattern BASE64_PATTERN =
                Pattern.compile("^[A-Za-z0-9+/]*={0,2}$");

        /** Maximum total decoded attachment size, in bytes (10 MB). */
        private static final long MAX_TOTAL_SIZE_BYTES = 10L * 1024 * 1024;

        private final String email;
        private String transactionalId;
        private String slug;
        private Map<String, Object> dataVariables;
        private String language;
        private List<TransactionalAttachment> attachments;

        private Builder(String email) {
            this.email = email;
        }

        public Builder transactionalId(String transactionalId) {
            this.transactionalId = transactionalId;
            return this;
        }

        public Builder slug(String slug) {
            this.slug = slug;
            return this;
        }

        /**
         * Sets the template data variables. Values may be any JSON primitive
         * supported by the template engine: {@link String}, {@link Number}
         * (e.g. {@link Integer}, {@link Long}, {@link Double}), or
         * {@link Boolean}. Each value is serialized as the matching JSON
         * primitive, so numeric and boolean variables are sent as JSON
         * numbers/booleans rather than quoted strings.
         *
         * @param dataVariables map of variable name to value
         * @return this builder
         */
        public Builder dataVariables(Map<String, Object> dataVariables) {
            this.dataVariables = dataVariables;
            return this;
        }

        public Builder language(String language) {
            this.language = language;
            return this;
        }

        public Builder attachments(List<TransactionalAttachment> attachments) {
            this.attachments = attachments;
            return this;
        }

        public Builder attachment(TransactionalAttachment attachment) {
            if (this.attachments == null) {
                this.attachments = new ArrayList<>();
            }
            this.attachments.add(attachment);
            return this;
        }

        public SendTransactionalParams build() {
            if (transactionalId == null && slug == null) {
                throw new IllegalArgumentException("Either transactionalId or slug must be provided");
            }
            if (attachments != null) {
                validateAttachments(attachments);
            }
            return new SendTransactionalParams(this);
        }

        /**
         * Validates the attachment list against the same guards the JS SDK
         * applies (packages/sdk-js src/resources/transactional.ts): a 10-item
         * cap, a dangerous-MIME deny-list, base64 content format, HTTPS-only
         * attachment URLs, and a 10MB total decoded-size cap. Without these a
         * Java caller could ship payloads the JS caller could not, and the gap
         * would widen silently.
         *
         * <p>{@code TransactionalAttachment.Builder} already enforces the
         * per-attachment filename and content-xor-url invariants at construction
         * time, so they are not re-checked here.
         */
        private static void validateAttachments(List<TransactionalAttachment> attachments) {
            if (attachments.size() > 10) {
                throw new IllegalArgumentException("Maximum 10 attachments allowed");
            }

            long totalSizeBytes = 0;

            for (TransactionalAttachment attachment : attachments) {
                String filename = attachment.getFilename();
                String content = attachment.getContent();
                String url = attachment.getUrl();
                String contentType = attachment.getContentType();

                // Validate base64 content format and track approximate decoded
                // size (base64 is ~4/3 of the original).
                if (content != null) {
                    if (!BASE64_PATTERN.matcher(content).matches()) {
                        throw new IllegalArgumentException(
                                "Attachment \"" + filename + "\" has invalid base64 content");
                    }
                    totalSizeBytes += (long) Math.ceil(content.length() * 3.0 / 4.0);
                }

                // Reject dangerous MIME types (case-insensitive).
                if (contentType != null
                        && DANGEROUS_MIME_TYPES.contains(contentType.toLowerCase())) {
                    throw new IllegalArgumentException(
                            "Attachment \"" + filename + "\" has a disallowed content type: " + contentType);
                }

                // Require HTTPS for URL-based attachments.
                if (url != null && !url.startsWith("https://")) {
                    throw new IllegalArgumentException(
                            "Attachment \"" + filename + "\" URL must use HTTPS");
                }
            }

            if (totalSizeBytes > MAX_TOTAL_SIZE_BYTES) {
                throw new IllegalArgumentException(
                        "Total attachment size (~" + Math.round(totalSizeBytes / 1024.0 / 1024.0)
                                + "MB) exceeds 10MB limit");
            }
        }
    }
}
