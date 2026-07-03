package com.owlat.sdk.internal;

import com.owlat.sdk.Owlat;
import com.owlat.sdk.OwlatConfig;
import com.owlat.sdk.RetryConfig;
import com.owlat.sdk.exception.AuthenticationException;
import com.owlat.sdk.exception.OwlatException;
import com.owlat.sdk.exception.RateLimitException;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * Regression: a 4xx/5xx response with an EMPTY body (gateway 502/503/504, edge
 * 429, proxy 401 — none of which carry a JSON error envelope) must surface the
 * typed exception and retry the retryable ones. The old code short-circuited any
 * empty body into {@code return null} BEFORE the {@code >= 400} branch, so these
 * came back as a null "success" and NPE'd the caller, with no retry on the
 * retryable ones.
 *
 * A throwaway in-process HttpServer replies with the given status and no body
 * ({@code sendResponseHeaders(status, -1)}), counting how many attempts arrive.
 */
class HttpClientEmptyBodyErrorTest {

    private HttpServer server;
    private String baseUrl;
    private final AtomicInteger attempts = new AtomicInteger();
    private volatile int status = 503;

    @BeforeEach
    void start() throws IOException {
        attempts.set(0);
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", this::handle);
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    private void handle(HttpExchange exchange) throws IOException {
        attempts.incrementAndGet();
        // -1 => no response body is written (an empty body).
        exchange.sendResponseHeaders(status, -1);
        exchange.close();
    }

    private Owlat client() {
        // maxRetries=2 (3 total attempts) with ~0ms backoff for a fast test.
        return new Owlat(OwlatConfig.builder("sk_test_123")
                .baseUrl(baseUrl)
                .retry(RetryConfig.builder().maxRetries(2).initialDelayMs(1).build())
                .build());
    }

    @Test
    void emptyBody503ThrowsAndRetriesTheIdempotentGet() {
        status = 503;
        OwlatException ex = assertThrows(OwlatException.class,
                () -> client().contacts().get("contact_123"));
        assertEquals(503, ex.getStatusCode());
        // idempotent GET + 5xx => maxRetries + 1 attempts, never a null success.
        assertEquals(3, attempts.get());
    }

    @Test
    void emptyBody429ThrowsRateLimitAndRetries() {
        status = 429;
        assertThrows(RateLimitException.class,
                () -> client().contacts().get("contact_123"));
        assertEquals(3, attempts.get());
    }

    @Test
    void emptyBody401ThrowsAuthenticationWithoutRetry() {
        status = 401;
        assertThrows(AuthenticationException.class,
                () -> client().contacts().get("contact_123"));
        // 401 is not retryable — exactly one attempt.
        assertEquals(1, attempts.get());
    }
}
