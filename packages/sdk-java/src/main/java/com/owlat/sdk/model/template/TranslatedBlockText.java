package com.owlat.sdk.model.template;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

/** The translated text of one block. A field left {@code null} keeps the default text. */
public class TranslatedBlockText {

    private final String html;
    private final String buttonText;
    private final String alt;

    @JsonCreator
    public TranslatedBlockText(
            @JsonProperty("html") String html,
            @JsonProperty("buttonText") String buttonText,
            @JsonProperty("alt") String alt) {
        this.html = html;
        this.buttonText = buttonText;
        this.alt = alt;
    }

    /** A text block's HTML. */
    public String getHtml() {
        return html;
    }

    /** A button's label. */
    public String getButtonText() {
        return buttonText;
    }

    /** An image's alt text. */
    public String getAlt() {
        return alt;
    }
}
