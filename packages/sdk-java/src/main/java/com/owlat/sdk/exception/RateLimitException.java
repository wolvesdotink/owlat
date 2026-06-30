package com.owlat.sdk.exception;

import com.owlat.sdk.model.RateLimitInfo;

import java.util.Map;

public class RateLimitException extends OwlatException {

    private final int retryAfter;

    public RateLimitException(String message, RateLimitInfo rateLimit, int retryAfter) {
        this(message, rateLimit, retryAfter, null);
    }

    public RateLimitException(String message, RateLimitInfo rateLimit, int retryAfter, Map<String, Object> data) {
        super(message, "rate_limited", 429, rateLimit, data);
        this.retryAfter = retryAfter;
    }

    public int getRetryAfter() {
        return retryAfter;
    }
}
