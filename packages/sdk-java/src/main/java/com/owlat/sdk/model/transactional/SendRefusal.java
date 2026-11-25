package com.owlat.sdk.model.transactional;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.Map;

/** The error a send would answer with, as its error body carries it. */
public class SendRefusal {

    private final int status;
    private final String category;
    private final String message;
    private final Map<String, Object> data;
    private final Integer retryAfter;

    @JsonCreator
    public SendRefusal(
            @JsonProperty("status") int status,
            @JsonProperty("category") String category,
            @JsonProperty("message") String message,
            @JsonProperty("data") Map<String, Object> data,
            @JsonProperty("retryAfter") Integer retryAfter) {
        this.status = status;
        this.category = category;
        this.message = message;
        this.data = data;
        this.retryAfter = retryAfter;
    }

    /** The HTTP status the send would answer with. */
    public int getStatus() {
        return status;
    }

    public String getCategory() {
        return category;
    }

    public String getMessage() {
        return message;
    }

    /** The send's {@code error.data}: {@code reason}, and for {@code invalid_variables} {@code field} and {@code variables}. */
    public Map<String, Object> getData() {
        return data;
    }

    /** Seconds a send would be told to wait, on a cap; otherwise {@code null}. */
    public Integer getRetryAfter() {
        return retryAfter;
    }
}
