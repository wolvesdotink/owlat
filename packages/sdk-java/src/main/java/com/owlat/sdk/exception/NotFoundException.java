package com.owlat.sdk.exception;

import com.owlat.sdk.model.RateLimitInfo;

import java.util.Map;

public class NotFoundException extends OwlatException {

    public NotFoundException(String message, RateLimitInfo rateLimit) {
        this(message, rateLimit, null);
    }

    public NotFoundException(String message, RateLimitInfo rateLimit, Map<String, Object> data) {
        super(message, "not_found", 404, rateLimit, data);
    }
}
