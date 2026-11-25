package com.owlat.sdk.model.template;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

/** A saved block in a list: everything but its content. */
public class SavedBlockSummary {

    private final String id;
    private final String name;
    private final String description;
    private final String createdAt;
    private final String updatedAt;

    @JsonCreator
    public SavedBlockSummary(
            @JsonProperty("id") String id,
            @JsonProperty("name") String name,
            @JsonProperty("description") String description,
            @JsonProperty("createdAt") String createdAt,
            @JsonProperty("updatedAt") String updatedAt) {
        this.id = id;
        this.name = name;
        this.description = description;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
    }

    public String getId() {
        return id;
    }

    public String getName() {
        return name;
    }

    /** What the block is for, or {@code null}. */
    public String getDescription() {
        return description;
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
