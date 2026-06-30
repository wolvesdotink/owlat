package com.owlat.sdk.model.topic;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

public class RemoveFromTopicResponse {

    private final boolean success;
    private final boolean removed;

    @JsonCreator
    public RemoveFromTopicResponse(
            @JsonProperty("success") boolean success,
            @JsonProperty("removed") boolean removed) {
        this.success = success;
        this.removed = removed;
    }

    public boolean isSuccess() {
        return success;
    }

    public boolean isRemoved() {
        return removed;
    }
}
