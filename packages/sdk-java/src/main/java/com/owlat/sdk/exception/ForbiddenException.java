package com.owlat.sdk.exception;

import com.owlat.sdk.model.RateLimitInfo;

import java.util.Map;

/**
 * Thrown when the request is authenticated but not permitted (403 status).
 * Maps the {@code forbidden} Operation error category — e.g. a suspended or
 * abuse-blocked account.
 */
public class ForbiddenException extends OwlatException {

    public ForbiddenException(String message, RateLimitInfo rateLimit) {
        this(message, rateLimit, null);
    }

    public ForbiddenException(String message, RateLimitInfo rateLimit, Map<String, Object> data) {
        super(message, "forbidden", 403, rateLimit, data);
    }
}
