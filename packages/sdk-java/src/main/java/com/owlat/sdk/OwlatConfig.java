package com.owlat.sdk;

import java.time.Duration;

public class OwlatConfig {

    private static final String DEFAULT_BASE_URL = "https://api.owlat.app";
    private static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(30);

    private final String apiKey;
    private final String baseUrl;
    private final Duration timeout;
    private final RetryConfig retry;

    private OwlatConfig(Builder builder) {
        this.apiKey = builder.apiKey;
        this.baseUrl = builder.baseUrl;
        this.timeout = builder.timeout;
        this.retry = builder.retry;
    }

    public String getApiKey() {
        return apiKey;
    }

    public String getBaseUrl() {
        return baseUrl;
    }

    public Duration getTimeout() {
        return timeout;
    }

    /**
     * Automatic retry configuration. Defaults to {@link RetryConfig#defaults()}
     * (the values the HTTP client previously hardcoded), so existing callers
     * behave identically. Tune it with {@link Builder#retry(RetryConfig)} or
     * disable retries entirely with {@link RetryConfig#disabled()}.
     */
    public RetryConfig getRetry() {
        return retry;
    }

    public static Builder builder(String apiKey) {
        return new Builder(apiKey);
    }

    public static class Builder {
        private final String apiKey;
        private String baseUrl = DEFAULT_BASE_URL;
        private Duration timeout = DEFAULT_TIMEOUT;
        private RetryConfig retry = RetryConfig.defaults();

        private Builder(String apiKey) {
            this.apiKey = apiKey;
        }

        public Builder baseUrl(String baseUrl) {
            this.baseUrl = baseUrl;
            return this;
        }

        public Builder timeout(Duration timeout) {
            this.timeout = timeout;
            return this;
        }

        /**
         * Sets the automatic retry configuration. Pass
         * {@link RetryConfig#disabled()} to turn retries off (the equivalent of
         * the JS SDK's {@code retry: false}). Defaults to
         * {@link RetryConfig#defaults()}.
         *
         * @throws IllegalArgumentException if {@code retry} is null
         */
        public Builder retry(RetryConfig retry) {
            if (retry == null) {
                throw new IllegalArgumentException(
                        "retry must not be null; use RetryConfig.disabled() to turn retries off");
            }
            this.retry = retry;
            return this;
        }

        public OwlatConfig build() {
            return new OwlatConfig(this);
        }
    }
}
