package com.owlat.sdk.exception;

import com.owlat.sdk.model.RateLimitInfo;

import java.util.Map;

/**
 * Thrown when a plan or quota limit has been reached (402 status). Maps the
 * {@code limit_reached} Operation error category. Distinct from
 * {@link RateLimitException} (429), which is a transient per-second throttle.
 */
public class LimitReachedException extends OwlatException {

    public LimitReachedException(String message, RateLimitInfo rateLimit) {
        this(message, rateLimit, null);
    }

    public LimitReachedException(String message, RateLimitInfo rateLimit, Map<String, Object> data) {
        super(message, "limit_reached", 402, rateLimit, data);
    }
}
