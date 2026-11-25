package com.owlat.sdk.model.template;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.Map;

/** One language of an email: its subject and the translated text of each block. */
public class EmailTranslation {

    private final String subject;
    private final Map<String, TranslatedBlockText> blocks;

    @JsonCreator
    public EmailTranslation(
            @JsonProperty("subject") String subject,
            @JsonProperty("blocks") Map<String, TranslatedBlockText> blocks) {
        this.subject = subject;
        this.blocks = blocks;
    }

    /** The subject in this language, or {@code null} to use the default subject. */
    public String getSubject() {
        return subject;
    }

    /** Each block's translated text, keyed by the block's id. */
    public Map<String, TranslatedBlockText> getBlocks() {
        return blocks;
    }
}
