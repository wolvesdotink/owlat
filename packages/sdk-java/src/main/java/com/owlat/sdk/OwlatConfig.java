package com.owlat.sdk;

import java.time.Duration;
import java.util.logging.Logger;

public class OwlatConfig {

    /**
     * The hosted Owlat address. No self-hosted instance answers here, so a
     * config left on it sends its API key to a host its owner did not choose.
     * Kept as the default only so existing callers do not break in a patch
     * release; {@link Builder#build()} warns whenever it is used, and the base
     * URL becomes required.
     */
    private static final String DEFAULT_BASE_URL = "https://api.owlat.app";
    private static final Logger LOGGER = Logger.getLogger("com.owlat.sdk");
    private static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(30);

    private final String apiKey;
    private final String baseUrl;
    private final Duration timeout;
    private final RetryConfig retry;

    private OwlatConfig(Builder builder, String baseUrl) {
        this.apiKey = builder.apiKey;
        this.baseUrl = baseUrl;
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
        private String baseUrl;
        // Only an omitted base URL takes the hosted default: an explicit null
        // (an unset environment variable) must not send the key there.
        private boolean baseUrlGiven;
        private Duration timeout = DEFAULT_TIMEOUT;
        private RetryConfig retry = RetryConfig.defaults();

        private Builder(String apiKey) {
            this.apiKey = apiKey;
        }

        /**
         * Your instance's API URL: "Your API base URL" in the web app under
         * Settings → API → API quickstart, which an operator sets as
         * {@code NUXT_PUBLIC_CONVEX_SITE_URL}. Left out, requests go to the
         * hosted address {@code https://api.owlat.app}, not to your instance,
         * and {@link #build()} logs a warning. It will become required.
         */
        public Builder baseUrl(String baseUrl) {
            this.baseUrl = baseUrl;
            this.baseUrlGiven = true;
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
            if (!baseUrlGiven) {
                LOGGER.warning("[owlat-sdk] No baseUrl given, so requests and the API key go to " + DEFAULT_BASE_URL
                        + ", not to your instance. Pass baseUrl: your instance's API URL"
                        + " (Settings → API → API quickstart in the web app). baseUrl will become required.");
                return new OwlatConfig(this, DEFAULT_BASE_URL);
            }
            return new OwlatConfig(this, baseUrl);
        }
    }
}
