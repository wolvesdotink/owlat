package com.owlat.sdk.internal;

import com.owlat.sdk.RequestOptions;
import com.owlat.sdk.RetryConfig;
import com.owlat.sdk.exception.ConflictException;
import com.owlat.sdk.exception.OwlatException;
import com.owlat.sdk.model.event.SendEventParams;
import com.owlat.sdk.model.transactional.SendTransactionalParams;
import com.owlat.sdk.resource.EventsResource;
import com.owlat.sdk.resource.TransactionalResource;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Retry eligibility of {@code POST} sends with and without an idempotency key.
 * A keyed send is retried after a 5xx with the same {@code Idempotency-Key}
 * header and the same body on every attempt; an unkeyed one never is; a 409
 * (key reused for another request) is never retried.
 *
 * A throwaway in-process HttpServer answers with a queue of statuses and
 * records each attempt's key header and body. The backoff never sleeps: the
 * client gets a sleeper that records each delay instead.
 */
class HttpClientIdempotencyTest {

    private static final String KEY = "order-1001-confirmation";

    private HttpServer server;
    private String baseUrl;
    private final List<String> keys = new CopyOnWriteArrayList<>();
    private final List<String> bodies = new CopyOnWriteArrayList<>();
    private final List<Long> delays = new CopyOnWriteArrayList<>();
    private volatile int[] statuses = {202};

    @BeforeEach
    void start() throws IOException {
        keys.clear();
        bodies.clear();
        delays.clear();
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
        int attempt = bodies.size();
        keys.add(String.valueOf(exchange.getRequestHeaders().getFirst("Idempotency-Key")));
        bodies.add(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
        int status = statuses[Math.min(attempt, statuses.length - 1)];
        byte[] response = (status < 400
                ? "{\"data\":{\"eventId\":\"evt_1\",\"status\":\"queued\"}}"
                : "{\"error\":{\"category\":\"" + (status == 409 ? "conflict" : "internal")
                        + "\",\"message\":\"failed\"}}")
                .getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, response.length);
        exchange.getResponseBody().write(response);
        exchange.close();
    }

    /** maxRetries=2 (3 total attempts) with the default backoff, recorded instead of slept. */
    private HttpClient http() {
        return new HttpClient("sk_test_123", baseUrl, Duration.ofSeconds(10),
                RetryConfig.builder().maxRetries(2).build(), delays::add);
    }

    private TransactionalResource transactionalResource() {
        return new TransactionalResource(http());
    }

    private EventsResource eventsResource() {
        return new EventsResource(http());
    }

    private static SendTransactionalParams transactional() {
        return SendTransactionalParams.builder("to@example.com").slug("welcome").build();
    }

    @Test
    void keyedTransactionalSendRetries5xxWithTheSameKeyAndBody() {
        statuses = new int[]{502, 503, 202};

        transactionalResource().send(transactional(), RequestOptions.idempotencyKey(KEY));

        assertEquals(List.of(KEY, KEY, KEY), keys);
        assertEquals(3, bodies.size());
        assertEquals(1, bodies.stream().distinct().count());
        assertEquals(List.of(500L, 1000L), delays);
    }

    @Test
    void keyedEventSendRetries5xx() {
        statuses = new int[]{500, 201};

        eventsResource().send(
                SendEventParams.builder("to@example.com", "signed_up").build(),
                RequestOptions.idempotencyKey(KEY));

        assertEquals(List.of(KEY, KEY), keys);
        assertEquals(List.of(500L), delays);
    }

    @Test
    void unkeyedSendIsNotRetriedAfter5xx() {
        statuses = new int[]{502, 202};

        OwlatException ex = assertThrows(OwlatException.class,
                () -> transactionalResource().send(transactional()));

        assertEquals(502, ex.getStatusCode());
        assertEquals(List.of("null"), keys);
        assertEquals(List.of(), delays);
    }

    @Test
    void conflictIsNeverRetried() {
        statuses = new int[]{409, 202};

        assertThrows(ConflictException.class,
                () -> transactionalResource().send(transactional(), RequestOptions.idempotencyKey(KEY)));

        assertEquals(1, keys.size());
        assertEquals(List.of(), delays);
    }

    @Test
    void keyedSendKeepsTheRetryLimit() {
        statuses = new int[]{503};

        assertThrows(OwlatException.class,
                () -> transactionalResource().send(transactional(), RequestOptions.idempotencyKey(KEY)));

        assertEquals(3, keys.size());
        assertEquals(List.of(500L, 1000L), delays);
    }

    @Test
    void rejectsMalformedKeys() {
        assertThrows(IllegalArgumentException.class, () -> RequestOptions.idempotencyKey(""));
        assertThrows(IllegalArgumentException.class, () -> RequestOptions.idempotencyKey("a b"));
        assertThrows(IllegalArgumentException.class, () -> RequestOptions.idempotencyKey(null));
        assertThrows(IllegalArgumentException.class,
                () -> RequestOptions.idempotencyKey("k".repeat(256)));
        assertEquals("k".repeat(255), RequestOptions.idempotencyKey("k".repeat(255)).getIdempotencyKey());
    }
}
