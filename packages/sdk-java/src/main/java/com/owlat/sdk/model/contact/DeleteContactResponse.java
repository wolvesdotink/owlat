package com.owlat.sdk.model.contact;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

public class DeleteContactResponse {

    private final String id;
    private final boolean deleted;

    @JsonCreator
    public DeleteContactResponse(
            @JsonProperty("id") String id,
            @JsonProperty("deleted") boolean deleted) {
        this.id = id;
        this.deleted = deleted;
    }

    public String getId() {
        return id;
    }

    public boolean isDeleted() {
        return deleted;
    }
}
