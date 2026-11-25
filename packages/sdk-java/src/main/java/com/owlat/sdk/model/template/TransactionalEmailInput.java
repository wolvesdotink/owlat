package com.owlat.sdk.model.template;

import java.util.List;
import java.util.Map;

/**
 * The editable fields of a transactional email. A write replaces all of them:
 * a field left {@code null} takes its default (no variables, no translations,
 * {@code en}, no unsubscribe link). Fields the API does not carry (sender,
 * attachments, the text/plain override) keep their value.
 */
public class TransactionalEmailInput {

    private final String slug;
    private final String name;
    private final String subject;
    private final List<Map<String, Object>> blocks;
    private final Map<String, EmailTranslation> translations;
    private final Map<String, String> dataVariablesSchema;
    private final String defaultLanguage;
    private final Boolean showUnsubscribe;

    private TransactionalEmailInput(Builder builder) {
        this.slug = builder.slug;
        this.name = builder.name;
        this.subject = builder.subject;
        this.blocks = builder.blocks;
        this.translations = builder.translations;
        this.dataVariablesSchema = builder.dataVariablesSchema;
        this.defaultLanguage = builder.defaultLanguage;
        this.showUnsubscribe = builder.showUnsubscribe;
    }

    /** Required on create; on an upsert, the slug in the path when given. */
    public String getSlug() {
        return slug;
    }

    public String getName() {
        return name;
    }

    public String getSubject() {
        return subject;
    }

    public List<Map<String, Object>> getBlocks() {
        return blocks;
    }

    public Map<String, EmailTranslation> getTranslations() {
        return translations;
    }

    public Map<String, String> getDataVariablesSchema() {
        return dataVariablesSchema;
    }

    public String getDefaultLanguage() {
        return defaultLanguage;
    }

    public Boolean getShowUnsubscribe() {
        return showUnsubscribe;
    }

    public static Builder builder(String name) {
        return new Builder(name);
    }

    public static class Builder {
        private final String name;
        private String slug;
        private String subject;
        private List<Map<String, Object>> blocks = List.of();
        private Map<String, EmailTranslation> translations;
        private Map<String, String> dataVariablesSchema;
        private String defaultLanguage;
        private Boolean showUnsubscribe;

        private Builder(String name) {
            this.name = name;
        }

        public Builder slug(String slug) {
            this.slug = slug;
            return this;
        }

        public Builder subject(String subject) {
            this.subject = subject;
            return this;
        }

        /** The blocks exactly as the editor stores them. */
        public Builder blocks(List<Map<String, Object>> blocks) {
            this.blocks = blocks;
            return this;
        }

        public Builder translations(Map<String, EmailTranslation> translations) {
            this.translations = translations;
            return this;
        }

        /** Variable name to type: {@code string}, {@code number}, {@code boolean} or {@code date}. */
        public Builder dataVariablesSchema(Map<String, String> dataVariablesSchema) {
            this.dataVariablesSchema = dataVariablesSchema;
            return this;
        }

        public Builder defaultLanguage(String defaultLanguage) {
            this.defaultLanguage = defaultLanguage;
            return this;
        }

        public Builder showUnsubscribe(boolean showUnsubscribe) {
            this.showUnsubscribe = showUnsubscribe;
            return this;
        }

        public TransactionalEmailInput build() {
            return new TransactionalEmailInput(this);
        }
    }
}
