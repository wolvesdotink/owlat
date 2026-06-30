package com.owlat.sdk.model;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Cursor-based pagination metadata returned with list responses.
 */
public class PaginationMeta {

    private final int limit;
    private final int totalItems;
    private final String cursor;
    private final boolean isDone;

    @JsonCreator
    public PaginationMeta(
            @JsonProperty("limit") int limit,
            @JsonProperty("totalItems") int totalItems,
            @JsonProperty("cursor") String cursor,
            @JsonProperty("isDone") boolean isDone) {
        this.limit = limit;
        this.totalItems = totalItems;
        this.cursor = cursor;
        this.isDone = isDone;
    }

    public int getLimit() {
        return limit;
    }

    public int getTotalItems() {
        return totalItems;
    }

    /**
     * Opaque continuation cursor for the next page, or {@code null} once
     * {@link #isDone()} is true (the final page has been returned).
     */
    public String getCursor() {
        return cursor;
    }

    /** True once the final page has been returned. */
    public boolean isDone() {
        return isDone;
    }
}
