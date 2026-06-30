package com.owlat.sdk.model;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

public class ApiResponse<T> {

    private final T data;

    @JsonCreator
    public ApiResponse(@JsonProperty("data") T data) {
        this.data = data;
    }

    public T getData() {
        return data;
    }
}
