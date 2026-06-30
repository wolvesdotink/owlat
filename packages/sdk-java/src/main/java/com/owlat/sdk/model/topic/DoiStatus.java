package com.owlat.sdk.model.topic;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

public enum DoiStatus {

    NOT_REQUIRED("not_required"),
    PENDING("pending"),
    CONFIRMED("confirmed");

    private final String value;

    DoiStatus(String value) {
        this.value = value;
    }

    @JsonValue
    public String getValue() {
        return value;
    }

    @JsonCreator
    public static DoiStatus fromValue(String value) {
        for (DoiStatus status : values()) {
            if (status.value.equals(value)) {
                return status;
            }
        }
        throw new IllegalArgumentException("Unknown DoiStatus: " + value);
    }
}
