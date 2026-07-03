package com.owlat.sdk.internal;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
     * Upper bound on a single {@code Retry-After} sleep, in milliseconds. Caps
     * the total bounded wait so a misbehaving or hostile {@code Retry-After}
     * header cannot block the caller indefinitely.
     */
    private static final long MAX_RETRY_AFTER_MS = 30_000L;

    /**
     * HTTP methods safe to auto-retry on a transient 5xx or network failure.
     * Excludes {@code POST}: a transactional/event {@code POST} the server
     * processed but whose response was lost must not be replayed (no
     * server-side idempotency key), or the send would be duplicated. A 429 is
     * retried regardless of method — it is a pre-processing rejection, so
     * replaying it cannot duplicate work.
     */
    private static final Set<HttpMethod> IDEMPOTENT_METHODS =
            Set.of(HttpMethod.GET, HttpMethod.PUT, HttpMethod.DELETE);

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

    /**
     * Constructs a client with the default retry configuration
     * ({@link RetryConfig#defaults()}).
     */
    public HttpClient(String apiKey, String baseUrl, Duration defaultTimeout) {
        this(apiKey, baseUrl, defaultTimeout, RetryConfig.defaults());
    }

    public HttpClient(String apiKey, String baseUrl, Duration defaultTimeout, RetryConfig retry) {
        this.apiKey = apiKey;
        this.baseUrl = baseUrl;
        this.defaultTimeout = defaultTimeout;
        RetryConfig effectiveRetry = retry != null ? retry : RetryConfig.defaults();
        this.maxRetries = effectiveRetry.getMaxRetries();
        this.initialDelayMs = effectiveRetry.getInitialDelayMs();
        this.backoffMultiplier = effectiveRetry.getBackoffMultiplier();
        this.client = java.net.http.HttpClient.newBuilder()
                .connectTimeout(defaultTimeout)
                .build();
        this.mapper = JsonMapper.instance();
    }

    public <T> T get(String path, TypeReference<T> typeRef) {
        return request(HttpMethod.GET, path, null, typeRef);
    }

    public <T> T post(String path, Object body, TypeReference<T> typeRef) {
        return request(HttpMethod.POST, path, body, typeRef);
    }

    public <T> T put(String path, Object body, TypeReference<T> typeRef) {
        return request(HttpMethod.PUT, path, body, typeRef);
    }

    public <T> T delete(String path, TypeReference<T> typeRef) {
        return request(HttpMethod.DELETE, path, null, typeRef);
    }

    private <T> T request(HttpMethod method, String path, Object body, TypeReference<T> typeRef) {
        String url = baseUrl + path;
        OwlatException lastError = null;

        for (int attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                HttpRequest.Builder requestBuilder = HttpRequest.newBuilder()
                        .uri(URI.create(url))
                        .timeout(defaultTimeout)
                        .header("Authorization", "Bearer " + apiKey)
                        .header("Content-Type", "application/json");

                if (body != null) {
                    String json = mapper.writeValueAsString(body);
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
                    // 429 is a pre-processing rejection — always retryable, and
                    // we honor Retry-After. 5xx is only replayed for idempotent
                    // methods so a POST the server may have already applied is
                    // never duplicated.
                    if (attempt < maxRetries && isRetryable(method, status)) {
                        long delayMs;
                        if (status == 429) {
                            // Retry-After is in seconds; fall back to backoff.
                            int retryAfterSeconds = parseHeader(response, "Retry-After", 0);
                            delayMs = retryAfterSeconds > 0
                                    ? Math.min(retryAfterSeconds * 1000L, MAX_RETRY_AFTER_MS)
                                    : backoffDelayMs(attempt);
                        } else {
                            delayMs = backoffDelayMs(attempt);
                        }
                        sleep(delayMs);
                        continue;
                    }
                    handleError(response, rateLimit);
                }

                // Empty success response (e.g., 204 No Content). Only reached
                // once we know the status is <400, so an empty error body can
                // never slip through here as a null "success".
                if (response.statusCode() == 204 || response.body().isEmpty()) {
                    return null;
                }

                return mapper.readValue(response.body(), typeRef);
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

            // Network error / timeout: retry only for idempotent methods. A
            // POST that timed out may have been processed server-side, so
            // replaying it would duplicate the send.
            if (attempt < maxRetries && IDEMPOTENT_METHODS.contains(method)) {
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

    /** Whether a failed request may be retried for the given method + status. */
    private boolean isRetryable(HttpMethod method, int status) {
        if (status == 429) {
            return true;
        }
        if (status == 500 || status == 502 || status == 503 || status == 504) {
            return IDEMPOTENT_METHODS.contains(method);
        }
        return false;
    }

    /** Exponential backoff delay for the given zero-based attempt. */
    private long backoffDelayMs(int attempt) {
        return initialDelayMs * (long) Math.pow(backoffMultiplier, attempt);
    }

    private void sleep(long millis) {
        try {
            Thread.sleep(millis);
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

    private void handleError(HttpResponse<String> response, RateLimitInfo rateLimit) {
        String message = "Unknown error";
        String category = "internal";
        java.util.Map<String, Object> data = null;

        try {
            JsonNode body = mapper.readTree(response.body());
            JsonNode error = body.get("error");
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
        } catch (IOException | IllegalArgumentException ignored) {
        }

        int statusCode = response.statusCode();
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
