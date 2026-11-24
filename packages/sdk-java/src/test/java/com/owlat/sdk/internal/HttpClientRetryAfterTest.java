package com.owlat.sdk.internal;

import com.owlat.sdk.RetryConfig;
import com.owlat.sdk.exception.RateLimitException;
import com.owlat.sdk.model.transactional.SendTransactionalParams;
import com.owlat.sdk.resource.TransactionalResource;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/**
 * How a 429 is retried, by its {@code Retry-After}. A send cap answers with a
 * wait of minutes or hours, which sleeping the capped 30 s and retrying cannot
 * outwait, so such a 429 is thrown at once with the server's wait. A shorter
 * one is waited out and retried; one without {@code Retry-After} keeps the
 * backoff.
 *
 * A throwaway in-process HttpServer answers the first request with a 429 and
 * later ones with 202. The client gets a sleeper that records each delay
 * instead of sleeping.
 */
class HttpClientRetryAfterTest {

    private HttpServer server;
    private String baseUrl;
    private final AtomicInteger requests = new AtomicInteger();
    private final List<Long> delays = new CopyOnWriteArrayList<>();
    private volatile String retryAfter;
    /** JSON for {@code data.retryAfter} in the 429's envelope, or null for none. */
    private volatile String bodyRetryAfter;

    @BeforeEach
    void start() throws IOException {
        requests.set(0);
        delays.clear();
        retryAfter = null;
        bodyRetryAfter = null;
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
        exchange.getRequestBody().readAllBytes();
        boolean first = requests.getAndIncrement() == 0;
        byte[] response = (first
                ? "{\"error\":{\"category\":\"rate_limited\",\"message\":\"Too many emails to this recipient\","
                        + "\"data\":{\"reason\":\"recipient_rate_limited\""
                        + (bodyRetryAfter != null ? ",\"retryAfter\":" + bodyRetryAfter : "") + "}}}"
                : "{\"data\":{\"id\":\"msg_1\",\"status\":\"queued\"}}")
                .getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        if (first && retryAfter != null) {
            exchange.getResponseHeaders().set("Retry-After", retryAfter);
        }
        exchange.sendResponseHeaders(first ? 429 : 202, response.length);
        exchange.getResponseBody().write(response);
        exchange.close();
    }

    private TransactionalResource transactional() {
        return new TransactionalResource(new HttpClient("sk_test_123", baseUrl, Duration.ofSeconds(10),
                RetryConfig.builder().maxRetries(2).build(), delays::add));
    }

    private static SendTransactionalParams params() {
        return SendTransactionalParams.builder("to@example.com").slug("password-reset").build();
    }

    @Test
    void retryAfterLongerThanTheCapIsThrownAtOnce() {
        retryAfter = "3600";

        RateLimitException ex = assertThrows(RateLimitException.class,
                () -> transactional().send(params()));

        assertEquals(3600, ex.getRetryAfter());
        assertEquals(Map.of("reason", "recipient_rate_limited"), ex.getData());
        assertEquals("recipient_rate_limited", ex.getReason());
        assertEquals(1, requests.get());
        assertEquals(List.of(), delays);
    }

    @Test
    void shortRetryAfterIsWaitedOutAndRetried() {
        retryAfter = "2";

        transactional().send(params());

        assertEquals(2, requests.get());
        assertEquals(List.of(2_000L), delays);
    }

    @Test
    void retryAfterAtTheCapIsWaitedOutAndRetried() {
        retryAfter = "30";

        transactional().send(params());

        assertEquals(2, requests.get());
        assertEquals(List.of(30_000L), delays);
    }

    @Test
    void missingRetryAfterKeepsTheBackoff() {
        retryAfter = null;

        transactional().send(params());

        assertEquals(2, requests.get());
        assertEquals(List.of(500L), delays);
    }

    @Test
    void bodyRetryAfterLongerThanTheCapIsThrownAtOnceOverAShortHeader() {
        retryAfter = "2";
        bodyRetryAfter = "3600";

        RateLimitException ex = assertThrows(RateLimitException.class,
                () -> transactional().send(params()));

        assertEquals(3600, ex.getRetryAfter());
        assertEquals(1, requests.get());
        assertEquals(List.of(), delays);
    }

    @Test
    void bodyRetryAfterIsWaitedOutOverALongHeader() {
        retryAfter = "3600";
        bodyRetryAfter = "2";

        transactional().send(params());

        assertEquals(2, requests.get());
        assertEquals(List.of(2_000L), delays);
    }

    @Test
    void theExceptionReportsTheWaitTheClientUsed() {
        retryAfter = "2";
        bodyRetryAfter = "5";

        RateLimitException ex = assertThrows(RateLimitException.class,
                () -> new TransactionalResource(new HttpClient("sk_test_123", baseUrl, Duration.ofSeconds(10),
                        RetryConfig.disabled(), delays::add)).send(params()));

        assertEquals(5, ex.getRetryAfter());
    }

    @Test
    void fractionalBodyRetryAfterIsRoundedUp() {
        bodyRetryAfter = "1.5";

        transactional().send(params());

        assertEquals(List.of(2_000L), delays);
    }

    @ParameterizedTest
    @ValueSource(strings = {"-5", "0", "\"5\""})
    void unreadableBodyRetryAfterFallsBackToTheHeader(String value) {
        retryAfter = "2";
        bodyRetryAfter = value;

        transactional().send(params());

        assertEquals(List.of(2_000L), delays);
    }

    @ParameterizedTest
    @ValueSource(strings = {"Wed, 21 Oct 2026 07:28:00 GMT", "-5", "0", "1.5", "+5", "soon"})
    void unreadableHeaderKeepsTheBackoff(String header) {
        retryAfter = header;

        transactional().send(params());

        assertEquals(2, requests.get());
        assertEquals(List.of(500L), delays);
    }

    @Test
    void noReadableValueReportsARetryAfterOfOne() {
        retryAfter = "0";
        bodyRetryAfter = "-5";

        RateLimitException ex = assertThrows(RateLimitException.class,
                () -> new TransactionalResource(new HttpClient("sk_test_123", baseUrl, Duration.ofSeconds(10),
                        RetryConfig.disabled(), delays::add)).send(params()));

        assertEquals(1, ex.getRetryAfter());
    }

    @ParameterizedTest
    @CsvSource(value = {"99999999999,", ",1e300"})
    void anAbsurdlyLargeWaitIsCappedAndThrownAtOnce(String header, String body) {
        retryAfter = header;
        bodyRetryAfter = body;

        RateLimitException ex = assertThrows(RateLimitException.class,
                () -> transactional().send(params()));

        assertEquals(Integer.MAX_VALUE, ex.getRetryAfter());
        assertEquals(1, requests.get());
    }
}
