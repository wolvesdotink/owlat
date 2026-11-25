package com.owlat.sdk.model.template;

import java.util.List;
import java.util.Map;

/**
 * Block content to render without storing it. A field left {@code null} takes
 * its default: a transactional email, no subject, no translations, {@code en}.
 */
public class RenderParams {

    private final String kind;
    private final String subject;
    private final String previewText;
    private final List<Map<String, Object>> blocks;
    private final Map<String, EmailTranslation> translations;
    private final String defaultLanguage;
    private final String language;
    private final Map<String, String> dataVariablesSchema;
    private final Map<String, Object> dataVariables;
    private final Boolean darkMode;

    private RenderParams(Builder builder) {
        this.kind = builder.kind;
        this.subject = builder.subject;
        this.previewText = builder.previewText;
        this.blocks = builder.blocks;
        this.translations = builder.translations;
        this.defaultLanguage = builder.defaultLanguage;
        this.language = builder.language;
        this.dataVariablesSchema = builder.dataVariablesSchema;
        this.dataVariables = builder.dataVariables;
        this.darkMode = builder.darkMode;
    }

    /** {@code transactional} (the default) or {@code template}. */
    public String getKind() {
        return kind;
    }

    public String getSubject() {
        return subject;
    }

    public String getPreviewText() {
        return previewText;
    }

    public List<Map<String, Object>> getBlocks() {
        return blocks;
    }

    public Map<String, EmailTranslation> getTranslations() {
        return translations;
    }

    public String getDefaultLanguage() {
        return defaultLanguage;
    }

    public String getLanguage() {
        return language;
    }

    public Map<String, String> getDataVariablesSchema() {
        return dataVariablesSchema;
    }

    public Map<String, Object> getDataVariables() {
        return dataVariables;
    }

    public Boolean getDarkMode() {
        return darkMode;
    }

    /** Render these blocks, as the editor stores them. */
    public static Builder builder(List<Map<String, Object>> blocks) {
        return new Builder(blocks);
    }

    public static class Builder {
        private final List<Map<String, Object>> blocks;
        private String kind;
        private String subject;
        private String previewText;
        private Map<String, EmailTranslation> translations;
        private String defaultLanguage;
        private String language;
        private Map<String, String> dataVariablesSchema;
        private Map<String, Object> dataVariables;
        private Boolean darkMode;

        private Builder(List<Map<String, Object>> blocks) {
            this.blocks = blocks;
        }

        /** Render as a marketing template: variables are contact fields. */
        public Builder template() {
            this.kind = "template";
            return this;
        }

        /** Render as a transactional email, the default. */
        public Builder transactional() {
            this.kind = "transactional";
            return this;
        }

        public Builder subject(String subject) {
            this.subject = subject;
            return this;
        }

        /** The inbox preview line, rendered as the hidden preheader. */
        public Builder previewText(String previewText) {
            this.previewText = previewText;
            return this;
        }

        public Builder translations(Map<String, EmailTranslation> translations) {
            this.translations = translations;
            return this;
        }

        public Builder defaultLanguage(String defaultLanguage) {
            this.defaultLanguage = defaultLanguage;
            return this;
        }

        /** The language to answer with; defaults to the default language. */
        public Builder language(String language) {
            this.language = language;
            return this;
        }

        /** Variable name to type, checked against the sample data as a send checks it. */
        public Builder dataVariablesSchema(Map<String, String> dataVariablesSchema) {
            this.dataVariablesSchema = dataVariablesSchema;
            return this;
        }

        /**
         * Sample data for a transactional email: the answer is then the email a
         * send with this data composes, values as in
         * {@link com.owlat.sdk.model.transactional.SendTransactionalParams.Builder#dataVariables}.
         */
        public Builder dataVariables(Map<String, Object> dataVariables) {
            this.dataVariables = dataVariables;
            return this;
        }

        /** Also answer the HTML as a client in dark mode shows it. */
        public Builder darkMode(boolean darkMode) {
            this.darkMode = darkMode;
            return this;
        }

        public RenderParams build() {
            return new RenderParams(this);
        }
    }
}
