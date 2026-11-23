package com.owlat.sdk.internal;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.owlat.sdk.RequestOptions;
import com.owlat.sdk.RetryConfig;
import com.owlat.sdk.exception.*;
import com.owlat.sdk.model.RateLimitInfo;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Set;

public class HttpClient {

    /**
     * Longest 429 {@code Retry-After} the client waits out before retrying, in
     * milliseconds. A longer one (a send cap refilling in minutes, a daily cap
     * resetting at midnight) is thrown at once as a {@link RateLimitException}
     * carrying the server's wait, so the caller can schedule its own retry
     * instead of blocking on a sleep that cannot outwait the cap.
     */
    private static final long MAX_RETRY_AFTER_MS = 30_000L;

    /**
     * HTTP methods safe to auto-retry on a transient 5xx or network failure.
     * Excludes {@code POST}: a transactional/event {@code POST} the server
     * processed but whose response was lost must not be replayed without an
     * idempotency key, or the send would be duplicated. A keyed {@code POST} is
     * replay-safe, since the server applies it at most once per key. A 429 is
     * retryable regardless of method — it is a pre-processing rejection, so
     * replaying it cannot duplicate work.
     */
    private static final Set<HttpMethod> IDEMPOTENT_METHODS =
            Set.of(HttpMethod.GET, HttpMethod.PUT, HttpMethod.DELETE);

    /** Longest stretch of a foreign response body an exception carries. */
    private static final int BODY_EXCERPT_LENGTH = 200;

    private final String apiKey;
    private final String baseUrl;
    private final Duration defaultTimeout;
    private final java.net.http.HttpClient client;
    private final ObjectMapper mapper;

    /**
     * Maximum number of retries (so {@code maxRetries + 1} total attempts).
     * Tunable via {@link RetryConfig}; defaults to the JS SDK value of 2.
     */
    private final int maxRetries;

    /** Initial backoff delay in milliseconds. Tunable via {@link RetryConfig}. */
    private final long initialDelayMs;

    /** Backoff multiplier for exponential backoff. Tunable via {@link RetryConfig}. */
    private final int backoffMultiplier;

    /** Waits out a retry delay. Tests pass one that records the delay instead of sleeping. */
    @FunctionalInterface
    interface Sleeper {
        void sleep(long millis) throws InterruptedException;
    }

    private final Sleeper sleeper;

    /**
     * Constructs a client with the default retry configuration
     * ({@link RetryConfig#defaults()}).
     */
    public HttpClient(String apiKey, String baseUrl, Duration defaultTimeout) {
        this(apiKey, baseUrl, defaultTimeout, RetryConfig.defaults());
    }

    public HttpClient(String apiKey, String baseUrl, Duration defaultTimeout, RetryConfig retry) {
        this(apiKey, baseUrl, defaultTimeout, retry, Thread::sleep);
    }

    HttpClient(String apiKey, String baseUrl, Duration defaultTimeout, RetryConfig retry, Sleeper sleeper) {
        this.apiKey = apiKey;
        this.baseUrl = baseUrl;
        this.defaultTimeout = defaultTimeout;
        RetryConfig effectiveRetry = retry != null ? retry : RetryConfig.defaults();
        this.maxRetries = effectiveRetry.getMaxRetries();
        this.initialDelayMs = effectiveRetry.getInitialDelayMs();
        this.backoffMultiplier = effectiveRetry.getBackoffMultiplier();
        this.sleeper = sleeper;
        this.client = java.net.http.HttpClient.newBuilder()
                .connectTimeout(defaultTimeout)
                .build();
        this.mapper = JsonMapper.instance();
    }

    public <T> T get(String path, TypeReference<T> typeRef) {
        return request(HttpMethod.GET, path, null, typeRef, null);
    }

    public <T> T post(String path, Object body, TypeReference<T> typeRef) {
        return request(HttpMethod.POST, path, body, typeRef, null);
    }

    /**
     * A {@code POST} with per-call options. With an idempotency key the request
     * carries an {@code Idempotency-Key} header and is retried like an
     * idempotent method.
     */
    public <T> T post(String path, Object body, TypeReference<T> typeRef, RequestOptions options) {
        return request(HttpMethod.POST, path, body, typeRef,
                options != null ? options.getIdempotencyKey() : null);
    }

    public <T> T put(String path, Object body, TypeReference<T> typeRef) {
        return request(HttpMethod.PUT, path, body, typeRef, null);
    }

    public <T> T delete(String path, TypeReference<T> typeRef) {
        return request(HttpMethod.DELETE, path, null, typeRef, null);
    }

    private <T> T request(HttpMethod method, String path, Object body, TypeReference<T> typeRef,
                          String idempotencyKey) {
        String url = baseUrl + path;
        OwlatException lastError = null;
        boolean replaySafe = IDEMPOTENT_METHODS.contains(method) || idempotencyKey != null;

        // Serialized once: every attempt under one key must carry the same
        // bytes, or the server would see a different request and refuse it.
        String json;
        try {
            json = body != null ? mapper.writeValueAsString(body) : null;
        } catch (IOException e) {
            throw new OwlatException(
                    "Failed to serialize request body: " + e.getMessage(),
                    "invalid_input", 0, null, e);
        }

        for (int attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                HttpRequest.Builder requestBuilder = HttpRequest.newBuilder()
                        .uri(URI.create(url))
                        .timeout(defaultTimeout)
                        .header("Authorization", "Bearer " + apiKey)
                        .header("Content-Type", "application/json");
                if (idempotencyKey != null) {
                    requestBuilder.header("Idempotency-Key", idempotencyKey);
                }

                if (json != null) {
                    requestBuilder.method(method.name(), HttpRequest.BodyPublishers.ofString(json));
                } else {
                    requestBuilder.method(method.name(), HttpRequest.BodyPublishers.noBody());
                }

                HttpResponse<String> response = client.send(
                        requestBuilder.build(),
                        HttpResponse.BodyHandlers.ofString()
                );

                RateLimitInfo rateLimit = extractRateLimit(response);

                // Error responses (>=400) MUST be handled before the empty-body
                // short-circuit below. A 4xx/5xx with an empty body (gateway
                // 502/503/504, edge 429, proxy 401) would otherwise be returned
                // as null "success" — the resource layer then NPEs, and the
                // retryable ones would never be retried.
                if (response.statusCode() >= 400) {
                    int status = response.statusCode();
                    int retryAfterSeconds = status == 429 ? parseHeader(response, "Retry-After", 0) : 0;
                    // 429 is a pre-processing rejection — retryable for any
                    // method, and we honor Retry-After. One asking for a longer
                    // wait than the client sleeps cannot be outwaited by
                    // retrying, so it is thrown at once. 5xx is only replayed
                    // for replay-safe requests so a POST the server may have
                    // already applied is never duplicated without an
                    // idempotency key. A 409 is never retried.
                    if (attempt < maxRetries && isRetryable(replaySafe, status)
                            && retryAfterSeconds * 1000L <= MAX_RETRY_AFTER_MS) {
                        long delayMs;
                        if (status == 429) {
                            // Retry-After is in seconds; fall back to backoff.
                            delayMs = retryAfterSeconds > 0
                                    ? retryAfterSeconds * 1000L
                                    : backoffDelayMs(attempt);
                        } else {
                            delayMs = backoffDelayMs(attempt);
                        }
                        sleep(delayMs);
                        continue;
                    }
                    handleError(response, rateLimit, url);
                }

                // Empty success response (e.g., 204 No Content). Only reached
                // once we know the status is <400, so an empty error body can
                // never slip through here as a null "success".
                if (response.statusCode() == 204 || response.body().isEmpty()) {
                    return null;
                }

                try {
                    return mapper.readValue(response.body(), typeRef);
                } catch (com.fasterxml.jackson.core.JsonParseException e) {
                    // The API answers every 2xx with JSON; an HTML page here is
                    // most often the web app's address given as the base URL.
                    throw new UnexpectedResponseException(response.statusCode(), displayUrl(url),
                            bodyExcerpt(response.body()), rateLimit);
                }
            } catch (OwlatException e) {
                throw e;
            } catch (java.net.http.HttpTimeoutException e) {
                lastError = new OwlatException(
                        "Request timed out after " + defaultTimeout.toMillis() + "ms",
                        "timeout", 0, null, e
                );
            } catch (IOException | InterruptedException e) {
                if (e instanceof InterruptedException) {
                    Thread.currentThread().interrupt();
                    throw new OwlatException(
                            "Request interrupted: " + e.getMessage(),
                            "network_error", 0, null, e
                    );
                }
                lastError = new OwlatException(
                        "Network error: " + e.getMessage(),
                        "network_error", 0, null, e
                );
            }

            // Network error / timeout: retry only replay-safe requests. A POST
            // that timed out may have been processed server-side, so replaying
            // it without an idempotency key would duplicate the send.
            if (attempt < maxRetries && replaySafe) {
                sleep(backoffDelayMs(attempt));
                continue;
            }
            throw lastError;
        }

        // Unreachable in practice: the loop either returns, throws, or sets
        // lastError before the final attempt.
        throw lastError != null
                ? lastError
                : new OwlatException("Max retries exceeded", "retry_exhausted", 0, null);
    }

    /** Whether a failed request may be retried, given whether it is replay-safe. */
    private boolean isRetryable(boolean replaySafe, int status) {
        if (status == 429) {
            return true;
        }
        if (status == 500 || status == 502 || status == 503 || status == 504) {
            return replaySafe;
        }
        return false;
    }

    /** Exponential backoff delay for the given zero-based attempt. */
    private long backoffDelayMs(int attempt) {
        return initialDelayMs * (long) Math.pow(backoffMultiplier, attempt);
    }

    private void sleep(long millis) {
        try {
            sleeper.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new OwlatException(
                    "Retry sleep interrupted", "network_error", 0, null, e
            );
        }
    }

    private RateLimitInfo extractRateLimit(HttpResponse<String> response) {
        int limit = parseHeader(response, "X-RateLimit-Limit", 10);
        int remaining = parseHeader(response, "X-RateLimit-Remaining", 10);
        int reset = parseHeader(response, "X-RateLimit-Reset", 0);
        return new RateLimitInfo(limit, remaining, reset);
    }

    private int parseHeader(HttpResponse<String> response, String name, int defaultValue) {
        return response.headers().firstValue(name)
                .map(v -> {
                    try {
                        return Integer.parseInt(v);
                    } catch (NumberFormatException e) {
                        return defaultValue;
                    }
                })
                .orElse(defaultValue);
    }

    /**
     * The start of a response body, on one line, for an exception message. A
     * server that echoes the request could put the API key in its body, so the
     * key is cut out before anything is kept.
     */
    private String bodyExcerpt(String rawBody) {
        String text = rawBody.replaceAll("\\s+", " ").trim();
        if (apiKey != null && !apiKey.isEmpty()) {
            text = text.replace(apiKey, "[redacted]");
        }
        return text.length() > BODY_EXCERPT_LENGTH ? text.substring(0, BODY_EXCERPT_LENGTH - 1) + "…" : text;
    }

    /**
     * The called URL as an exception may show it: without credentials in the
     * authority, and without the query string, which can hold a contact's email.
     */
    private static String displayUrl(String url) {
        String withoutQuery = url.split("[?#]", 2)[0];
        return withoutQuery.replaceFirst("^([A-Za-z][A-Za-z0-9+.-]*://)[^/@]*@", "$1");
    }

    private void handleError(HttpResponse<String> response, RateLimitInfo rateLimit, String url) {
        String message = "Unknown error";
        String category = "internal";
        java.util.Map<String, Object> data = null;
        int statusCode = response.statusCode();
        String rawBody = response.body();

        // The API wraps every failure of its own in the envelope, so a body that
        // is there but is not one came from something else: a wrong host or
        // path, or a proxy. An empty body keeps the status's typed exception, and
        // a 429 stays a rate limit whoever sent it, since proxies throttle too.
        JsonNode error = null;
        if (!rawBody.isEmpty()) {
            try {
                JsonNode body = mapper.readTree(rawBody);
                JsonNode candidate = body != null && body.isObject() ? body.get("error") : null;
                if (candidate != null && candidate.isObject()) {
                    error = candidate;
                }
            } catch (IOException ignored) {
            }
            if (error == null && statusCode != 429) {
                throw new UnexpectedResponseException(statusCode, displayUrl(url), bodyExcerpt(rawBody), rateLimit);
            }
        }

        try {
            if (error != null) {
                if (error.has("message")) {
                    message = error.get("message").asText();
                }
                if (error.has("category")) {
                    category = error.get("category").asText();
                }
                JsonNode dataNode = error.get("data");
                if (dataNode != null && dataNode.isObject()) {
                    @SuppressWarnings("unchecked")
                    java.util.Map<String, Object> parsed = mapper.convertValue(
                            dataNode, java.util.Map.class);
                    data = parsed;
                }
            }
        } catch (IllegalArgumentException ignored) {
        }

        switch (statusCode) {
            case 401:
                throw new AuthenticationException(message, rateLimit, data);
            case 402:
                throw new LimitReachedException(message, rateLimit, data);
            case 403:
                throw new ForbiddenException(message, rateLimit, data);
            case 404:
                throw new NotFoundException(message, rateLimit, data);
            case 409:
                throw new ConflictException(message, rateLimit, data);
            case 422:
                throw new InvalidStateException(message, rateLimit, data);
            case 429:
                int retryAfterHeader = parseHeader(response, "Retry-After", 1);
                int retryAfter = data != null && data.get("retryAfter") instanceof Number
                        ? ((Number) data.get("retryAfter")).intValue()
                        : retryAfterHeader;
                throw new RateLimitException(message, rateLimit, retryAfter, data);
            case 400:
                throw new ValidationException(message, rateLimit, data);
            default:
                throw new OwlatException(message, category, statusCode, rateLimit, data);
        }
    }
}
