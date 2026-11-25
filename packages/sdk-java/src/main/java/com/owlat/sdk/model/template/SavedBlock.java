package com.owlat.sdk.model.template;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;
import java.util.Map;

/** A saved block with its blocks. */
public class SavedBlock {

    private final String id;
    private final String name;
    private final String description;
    private final String createdAt;
    private final String updatedAt;
    private final List<Map<String, Object>> blocks;

    @JsonCreator
    public SavedBlock(
            @JsonProperty("id") String id,
            @JsonProperty("name") String name,
            @JsonProperty("description") String description,
            @JsonProperty("createdAt") String createdAt,
            @JsonProperty("updatedAt") String updatedAt,
            @JsonProperty("blocks") List<Map<String, Object>> blocks) {
        this.id = id;
        this.name = name;
        this.description = description;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
        this.blocks = blocks;
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

    /** The blocks exactly as the editor stores them. */
    public List<Map<String, Object>> getBlocks() {
        return blocks;
    }
}
