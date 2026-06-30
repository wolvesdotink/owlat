package com.owlat.sdk.exception;

import com.owlat.sdk.model.RateLimitInfo;

import java.util.Map;

public class ValidationException extends OwlatException {

    public ValidationException(String message, RateLimitInfo rateLimit) {
        this(message, rateLimit, null);
    }

    public ValidationException(String message, RateLimitInfo rateLimit, Map<String, Object> data) {
        super(message, "invalid_input", 400, rateLimit, data);
    }
}
