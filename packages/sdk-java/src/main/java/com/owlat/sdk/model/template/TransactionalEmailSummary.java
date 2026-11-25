package com.owlat.sdk.model.template;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;

/** A transactional email in a list: everything but its content. */
public class TransactionalEmailSummary {

    private final String id;
    private final String slug;
    private final String name;
    private final String status;
    private final String subject;
    private final String defaultLanguage;
    private final List<String> languages;
    private final int revision;
    private final String publishedAt;
    private final String createdAt;
    private final String updatedAt;

    @JsonCreator
    public TransactionalEmailSummary(
            @JsonProperty("id") String id,
            @JsonProperty("slug") String slug,
            @JsonProperty("name") String name,
            @JsonProperty("status") String status,
            @JsonProperty("subject") String subject,
            @JsonProperty("defaultLanguage") String defaultLanguage,
            @JsonProperty("languages") List<String> languages,
            @JsonProperty("revision") int revision,
            @JsonProperty("publishedAt") String publishedAt,
            @JsonProperty("createdAt") String createdAt,
            @JsonProperty("updatedAt") String updatedAt) {
        this.id = id;
        this.slug = slug;
        this.name = name;
        this.status = status;
        this.subject = subject;
        this.defaultLanguage = defaultLanguage;
        this.languages = languages;
        this.revision = revision;
        this.publishedAt = publishedAt;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
    }

    /** The ID a send may name as {@code transactionalId}. */
    public String getId() {
        return id;
    }

    public String getSlug() {
        return slug;
    }

    public String getName() {
        return name;
    }

    /** {@code draft}, {@code pending_review} or {@code published}. */
    public String getStatus() {
        return status;
    }

    /** The default-language subject. */
    public String getSubject() {
        return subject;
    }

    public String getDefaultLanguage() {
        return defaultLanguage;
    }

    /** Every language the email can be sent in, the default language first. */
    public List<String> getLanguages() {
        return languages;
    }

    /** The content revision. Pass it as {@code ifRevision} to refuse a write when the email changed since this read. */
    public int getRevision() {
        return revision;
    }

    /** ISO 8601 timestamp of the last publish, or {@code null} while not published. */
    public String getPublishedAt() {
        return publishedAt;
    }

    /** ISO 8601 timestamp. */
    public String getCreatedAt() {
        return createdAt;
    }

    /** ISO 8601 timestamp. */
    public String getUpdatedAt() {
        return updatedAt;
    }
}
