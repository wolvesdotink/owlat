package com.owlat.sdk.model.template;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;

/** What a create or upsert of a transactional email answers. */
public class TransactionalEmailWriteResult {

    private final TransactionalEmail email;
    private final List<ContentIssue> issues;

    @JsonCreator
    public TransactionalEmailWriteResult(
            @JsonProperty("email") TransactionalEmail email,
            @JsonProperty("issues") List<ContentIssue> issues) {
        this.email = email;
        this.issues = issues;
    }

    public TransactionalEmail getEmail() {
        return email;
    }

    /** Warnings and notes about the stored content. */
    public List<ContentIssue> getIssues() {
        return issues;
    }
}
