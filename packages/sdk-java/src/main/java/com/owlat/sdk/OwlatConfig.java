package com.owlat.sdk;

import java.net.URI;
import java.net.URISyntaxException;
import java.time.Duration;
import java.util.Locale;

public class OwlatConfig {

    private static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(30);
    private static final String WHERE_TO_FIND_IT = "Pass your instance's API URL: the web app shows it as"
            + " \"Your API base URL\" under Settings → API → API quickstart."
            + " It is the NUXT_PUBLIC_CONVEX_SITE_URL your operator set.";
    private static final String NOT_HTTP =
            "must be an absolute http or https URL, such as https://rest.api.example.com";

    private final String apiKey;
    private final String baseUrl;
    private final Duration timeout;
    private final RetryConfig retry;

    private OwlatConfig(Builder builder) {
        this.apiKey = builder.apiKey;
        this.baseUrl = normalizeBaseUrl(builder.baseUrl);
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
        private Duration timeout = DEFAULT_TIMEOUT;
        private RetryConfig retry = RetryConfig.defaults();

        private Builder(String apiKey) {
            this.apiKey = apiKey;
        }

        /**
         * Your instance's API URL: "Your API base URL" in the web app under
         * Settings → API → API quickstart, which an operator sets as
         * {@code NUXT_PUBLIC_CONVEX_SITE_URL}. Required: an absolute
         * {@code http} or {@code https} URL, with an optional path prefix and
         * no query string or fragment; a trailing slash is dropped.
         * {@link #build()} throws otherwise.
         */
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

        /**
         * @throws IllegalArgumentException if no base URL was set, or it is
         *     not an absolute {@code http} or {@code https} URL
         */
        public OwlatConfig build() {
            return new OwlatConfig(this);
        }
    }

    private static IllegalArgumentException refused(String problem) {
        return new IllegalArgumentException("baseUrl " + problem + ". " + WHERE_TO_FIND_IT);
    }

    /**
     * Checks the instance's API URL once and returns it in the form the HTTP
     * client expects. Each request URL is the base URL followed by a path
     * that starts with {@code /}, so a path prefix (an API behind a reverse
     * proxy at {@code /owlat}) carries through, a trailing slash would double
     * the slash and is dropped, and a query string or fragment would swallow
     * the path and is refused. Messages never echo the value: it may be an
     * API key set in the wrong field, or carry a password.
     */
    private static String normalizeBaseUrl(String value) {
        if (value == null || value.isBlank()) {
            throw refused("is required");
        }
        if (value.chars().anyMatch(Character::isWhitespace)) {
            throw refused("must not contain whitespace");
        }
        URI uri;
        try {
            uri = new URI(value);
        } catch (URISyntaxException e) {
            throw refused(NOT_HTTP);
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!(scheme.equals("http") || scheme.equals("https")) || uri.getHost() == null) {
            throw refused(NOT_HTTP);
        }
        if (value.indexOf('?') >= 0 || value.indexOf('#') >= 0) {
            throw refused("must not have a query string or fragment, since each request appends its path");
        }
        if (uri.getRawUserInfo() != null) {
            throw refused("must not carry a user name or password");
        }
        return value.replaceAll("/+$", "");
    }
}
