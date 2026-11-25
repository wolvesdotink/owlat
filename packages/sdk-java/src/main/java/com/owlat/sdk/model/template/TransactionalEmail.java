package com.owlat.sdk.model.template;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;
import java.util.Map;

/** A transactional email with its content. Its {@link #toInput()} is what an upsert of the same slug accepts. */
public class TransactionalEmail {

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
    private final List<Map<String, Object>> blocks;
    private final Map<String, EmailTranslation> translations;
    private final Map<String, String> dataVariablesSchema;
    private final boolean showUnsubscribe;

    @JsonCreator
    public TransactionalEmail(
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
            @JsonProperty("updatedAt") String updatedAt,
            @JsonProperty("blocks") List<Map<String, Object>> blocks,
            @JsonProperty("translations") Map<String, EmailTranslation> translations,
            @JsonProperty("dataVariablesSchema") Map<String, String> dataVariablesSchema,
            @JsonProperty("showUnsubscribe") boolean showUnsubscribe) {
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
        this.blocks = blocks;
        this.translations = translations;
        this.dataVariablesSchema = dataVariablesSchema;
        this.showUnsubscribe = showUnsubscribe;
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

    /** The blocks exactly as the editor stores them. */
    public List<Map<String, Object>> getBlocks() {
        return blocks;
    }

    /** The other languages, keyed by language code. */
    public Map<String, EmailTranslation> getTranslations() {
        return translations;
    }

    /** The data variables a send passes, by name, with their type. */
    public Map<String, String> getDataVariablesSchema() {
        return dataVariablesSchema;
    }

    /** Whether the email shows an unsubscribe link. */
    @JsonProperty("showUnsubscribe")
    public boolean isShowUnsubscribe() {
        return showUnsubscribe;
    }

    /** The editable fields of this email, ready for an upsert: the read is the export. */
    public TransactionalEmailInput toInput() {
        return TransactionalEmailInput.builder(name)
                .subject(subject)
                .blocks(blocks)
                .translations(translations)
                .dataVariablesSchema(dataVariablesSchema)
                .defaultLanguage(defaultLanguage)
                .showUnsubscribe(showUnsubscribe)
                .build();
    }
}
