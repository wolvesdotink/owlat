package com.owlat.sdk.model;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

public class PaginatedResponse<T> {

    private final List<T> data;
    private final PaginationMeta pagination;

    @JsonCreator
    public PaginatedResponse(
            @JsonProperty("data") List<T> data,
            @JsonProperty("pagination") PaginationMeta pagination) {
        this.data = data;
        this.pagination = pagination;
    }

    public List<T> getData() {
        return data;
    }

    public PaginationMeta getPagination() {
        return pagination;
    }
}
