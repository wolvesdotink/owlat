package com.owlat.sdk.model.template;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

/** Something the content check found: a broken or risky block, or a renderer warning. */
public class ContentIssue {

    private final String severity;
    private final String code;
    private final String message;
    private final String blockId;
    private final String blockType;

    @JsonCreator
    public ContentIssue(
            @JsonProperty("severity") String severity,
            @JsonProperty("code") String code,
            @JsonProperty("message") String message,
            @JsonProperty("blockId") String blockId,
            @JsonProperty("blockType") String blockType) {
        this.severity = severity;
        this.code = code;
        this.message = message;
        this.blockId = blockId;
        this.blockType = blockType;
    }

    /** {@code error}, {@code warning} or {@code info}. Only an error refuses a write. */
    public String getSeverity() {
        return severity;
    }

    /** A stable code such as {@code BUTTON_NO_URL}, or {@code RENDER_WARNING}. */
    public String getCode() {
        return code;
    }

    public String getMessage() {
        return message;
    }

    /** The block at fault, or {@code null} for the whole email. */
    public String getBlockId() {
        return blockId;
    }

    public String getBlockType() {
        return blockType;
    }
}
