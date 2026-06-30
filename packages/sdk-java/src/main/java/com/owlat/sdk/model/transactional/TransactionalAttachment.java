package com.owlat.sdk.model.transactional;

/**
 * An attachment to include with a transactional email.
 */
public class TransactionalAttachment {

    private final String filename;
    private final String content;
    private final String url;
    private final String contentType;

    private TransactionalAttachment(Builder builder) {
        this.filename = builder.filename;
        this.content = builder.content;
        this.url = builder.url;
        this.contentType = builder.contentType;
    }

    public String getFilename() {
        return filename;
    }

    public String getContent() {
        return content;
    }

    public String getUrl() {
        return url;
    }

    public String getContentType() {
        return contentType;
    }

    public static Builder builder(String filename) {
        return new Builder(filename);
    }

    public static class Builder {
        private final String filename;
        private String content;
        private String url;
        private String contentType;

        private Builder(String filename) {
            this.filename = filename;
        }

        public Builder content(String content) {
            this.content = content;
            return this;
        }

        public Builder url(String url) {
            this.url = url;
            return this;
        }

        public Builder contentType(String contentType) {
            this.contentType = contentType;
            return this;
        }

        public TransactionalAttachment build() {
            if (filename == null || filename.isEmpty()) {
                throw new IllegalArgumentException("filename is required");
            }
            if (content != null && url != null) {
                throw new IllegalArgumentException("Attachment must have either content or url, not both");
            }
            if (content == null && url == null) {
                throw new IllegalArgumentException("Attachment must have either content or url");
            }
            return new TransactionalAttachment(this);
        }
    }
}
