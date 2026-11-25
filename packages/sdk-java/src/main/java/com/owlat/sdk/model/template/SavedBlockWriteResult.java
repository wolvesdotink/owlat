package com.owlat.sdk.model.template;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;

/** What a create or update of a saved block answers. */
public class SavedBlockWriteResult {

    private final SavedBlock block;
    private final List<ContentIssue> issues;

    @JsonCreator
    public SavedBlockWriteResult(
            @JsonProperty("block") SavedBlock block,
            @JsonProperty("issues") List<ContentIssue> issues) {
        this.block = block;
        this.issues = issues;
    }

    public SavedBlock getBlock() {
        return block;
    }

    /** Warnings and notes about the stored content. */
    public List<ContentIssue> getIssues() {
        return issues;
    }
}
