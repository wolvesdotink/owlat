package com.owlat.sdk.model;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Pagination of a list that has no total: the page says only whether more
 * follow, since counting every match would read every match.
 */
public class CursorPaginationMeta {

    private final int limit;
    private final String cursor;
    private final boolean isDone;

    @JsonCreator
    public CursorPaginationMeta(
            @JsonProperty("limit") int limit,
            @JsonProperty("cursor") String cursor,
            @JsonProperty("isDone") boolean isDone) {
        this.limit = limit;
        this.cursor = cursor;
        this.isDone = isDone;
    }

    public int getLimit() {
        return limit;
    }

    /**
     * Opaque continuation cursor for the next page, or {@code null} once
     * {@link #isDone()} is true. It belongs to the filters of the request that
     * returned it.
     */
    public String getCursor() {
        return cursor;
    }

    /** True once the final page has been returned. */
    public boolean isDone() {
        return isDone;
    }
}
