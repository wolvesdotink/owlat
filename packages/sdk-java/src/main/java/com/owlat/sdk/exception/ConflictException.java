package com.owlat.sdk.exception;

import com.owlat.sdk.model.RateLimitInfo;

import java.util.Map;

public class ConflictException extends OwlatException {

    public ConflictException(String message, RateLimitInfo rateLimit) {
        this(message, rateLimit, null);
    }

    public ConflictException(String message, RateLimitInfo rateLimit, Map<String, Object> data) {
        super(message, "conflict", 409, rateLimit, data);
    }
}
