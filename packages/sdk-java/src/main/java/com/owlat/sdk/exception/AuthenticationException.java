package com.owlat.sdk.exception;

import com.owlat.sdk.model.RateLimitInfo;

import java.util.Map;

public class AuthenticationException extends OwlatException {

    public AuthenticationException(String message, RateLimitInfo rateLimit) {
        this(message, rateLimit, null);
    }

    public AuthenticationException(String message, RateLimitInfo rateLimit, Map<String, Object> data) {
        super(message, "unauthenticated", 401, rateLimit, data);
    }
}
