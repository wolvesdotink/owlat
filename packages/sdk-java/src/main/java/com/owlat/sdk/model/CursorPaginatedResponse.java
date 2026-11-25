package com.owlat.sdk.model;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

/** One page of a list that has no total. */
public class CursorPaginatedResponse<T> {

    private final List<T> data;
    private final CursorPaginationMeta pagination;

    @JsonCreator
    public CursorPaginatedResponse(
            @JsonProperty("data") List<T> data,
            @JsonProperty("pagination") CursorPaginationMeta pagination) {
        this.data = data;
        this.pagination = pagination;
    }

    public List<T> getData() {
        return data;
    }

    public CursorPaginationMeta getPagination() {
        return pagination;
    }
}
