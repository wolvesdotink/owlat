package com.owlat.sdk.exception;

import com.owlat.sdk.model.RateLimitInfo;

import java.util.Map;

public class OwlatException extends RuntimeException {

    private final String code;
    private final int statusCode;
    private final RateLimitInfo rateLimit;
    private final Map<String, Object> data;

    public OwlatException(String message, String code, int statusCode, RateLimitInfo rateLimit) {
        this(message, code, statusCode, rateLimit, (Map<String, Object>) null);
    }

    public OwlatException(String message, String code, int statusCode, RateLimitInfo rateLimit, Map<String, Object> data) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
        this.rateLimit = rateLimit;
        this.data = data;
    }

    public OwlatException(String message, String code, int statusCode, RateLimitInfo rateLimit, Throwable cause) {
        super(message, cause);
        this.code = code;
        this.statusCode = statusCode;
        this.rateLimit = rateLimit;
        this.data = null;
    }

    /**
     * The Operation error category from the API (e.g. "not_found",
     * "invalid_input", "rate_limited"), or a synthetic client code
     * ("timeout", "network_error") for faults that never reached the API.
     */
    public String getCode() {
        return code;
    }

    public int getStatusCode() {
        return statusCode;
    }

    public RateLimitInfo getRateLimit() {
        return rateLimit;
    }

    /**
     * Operation error specifics carried alongside the category — e.g.
     * {@code {"field": "email"}}, {@code {"retryAfter": 30}}. Null when the
     * response carried none.
     */
    public Map<String, Object> getData() {
        return data;
    }
}
