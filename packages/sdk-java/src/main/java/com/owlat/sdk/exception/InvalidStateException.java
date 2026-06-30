package com.owlat.sdk.exception;

import com.owlat.sdk.model.RateLimitInfo;

import java.util.Map;

/**
 * Thrown when the resource is in a state that disallows the operation
 * (422 status). Maps the {@code invalid_state} Operation error category —
 * e.g. a blocked recipient, an unpublished template, a template with no
 * content, or an unverified sending domain.
 */
public class InvalidStateException extends OwlatException {

    public InvalidStateException(String message, RateLimitInfo rateLimit) {
        this(message, rateLimit, null);
    }

    public InvalidStateException(String message, RateLimitInfo rateLimit, Map<String, Object> data) {
        super(message, "invalid_state", 422, rateLimit, data);
    }
}
