package com.owlat.sdk.internal;

import com.owlat.sdk.Owlat;
import com.owlat.sdk.OwlatConfig;
import com.owlat.sdk.RetryConfig;
import com.owlat.sdk.exception.NotFoundException;
import com.owlat.sdk.exception.OwlatException;
import com.owlat.sdk.exception.RateLimitException;
import com.owlat.sdk.exception.UnexpectedResponseException;
import com.owlat.sdk.model.PaginationParams;
import com.owlat.sdk.model.transactional.SendTransactionalParams;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * A response that is not the API's error envelope is what a wrong baseUrl
 * answers with: the Convex router's plain-text 404 for a path it has no action
 * for, a proxy's HTML error page, or the web app's HTML page served with 200.
 * It must name the status, the URL and the body, and never the API key.
 */
class HttpClientUnexpectedResponseTest {

    private static final String API_KEY = "lm_live_secret_key";
    private static final String HTML_502 =
            "<html>\n<head><title>502 Bad Gateway</title></head>\n<body>\n"
                    + "<center><h1>502 Bad Gateway</h1></center>\n<hr><center>nginx</center>\n</body>\n</html>\n";

    private HttpServer server;
    private String baseUrl;
    private final AtomicInteger attempts = new AtomicInteger();
    private volatile int status = 404;
    private volatile String body = "";
    private volatile String retryAfter = null;

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
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        if (retryAfter != null) {
            exchange.getResponseHeaders().add("Retry-After", retryAfter);
        }
        exchange.sendResponseHeaders(status, bytes.length == 0 ? -1 : bytes.length);
        if (bytes.length > 0) {
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(bytes);
            }
        }
        exchange.close();
    }

    private Owlat client(int maxRetries) {
        return new Owlat(OwlatConfig.builder(API_KEY)
                .baseUrl(baseUrl)
                .retry(RetryConfig.builder().maxRetries(maxRetries).initialDelayMs(1).build())
                .build());
    }

    @Test
    void plainText404NamesStatusUrlAndBody() {
        status = 404;
        body = "No HttpAction routed for /x";

        OwlatException thrown = assertThrows(OwlatException.class,
                () -> client(0).contacts().get("contact_123"));

        assertFalse(thrown instanceof NotFoundException, "a router 404 is not a missing contact");
        UnexpectedResponseException ex = assertInstanceOf(UnexpectedResponseException.class, thrown);
        assertEquals("unexpected_response", ex.getCode());
        assertEquals(404, ex.getStatusCode());
        assertEquals(baseUrl + "/api/v1/contacts/contact_123", ex.getUrl());
        assertEquals("No HttpAction routed for /x", ex.getBodyExcerpt());
        assertTrue(ex.getMessage().contains(ex.getUrl()), ex.getMessage());
        assertTrue(ex.getMessage().contains("404"), ex.getMessage());
        assertTrue(ex.getMessage().contains("No HttpAction routed for /x"), ex.getMessage());
        assertTrue(ex.getMessage().contains("baseUrl"), ex.getMessage());
    }

    @Test
    void html502NamesStatusUrlAndTheStartOfThePage() {
        status = 502;
        body = HTML_502;

        UnexpectedResponseException ex = assertThrows(UnexpectedResponseException.class,
                () -> client(0).transactional().send(
                        SendTransactionalParams.builder("user@example.com").slug("welcome").build()));

        assertEquals(502, ex.getStatusCode());
        assertEquals(baseUrl + "/api/v1/transactional", ex.getUrl());
        assertTrue(ex.getBodyExcerpt().contains("<title>502 Bad Gateway</title>"), ex.getBodyExcerpt());
        assertFalse(ex.getBodyExcerpt().contains("\n"));
        assertTrue(ex.getMessage().contains("502"), ex.getMessage());
    }

    @Test
    void neverCarriesTheApiKeyEvenWhenTheBodyEchoesIt() {
        status = 400;
        body = "<pre>Authorization: Bearer " + API_KEY + "</pre>";

        UnexpectedResponseException ex = assertThrows(UnexpectedResponseException.class,
                () -> client(0).contacts().get("contact_123"));

        assertFalse(ex.getMessage().contains(API_KEY), ex.getMessage());
        assertFalse(ex.getBodyExcerpt().contains(API_KEY), ex.getBodyExcerpt());
    }

    @Test
    void leavesTheQueryStringOutOfTheUrl() {
        status = 404;
        body = "Not Found";

        UnexpectedResponseException ex = assertThrows(UnexpectedResponseException.class,
                () -> client(0).contacts().list(
                        PaginationParams.builder().search("user@example.com").build()));

        assertFalse(ex.getUrl().contains("?"), ex.getUrl());
        assertFalse(ex.getMessage().contains("example.com"), ex.getMessage());
    }

    @Test
    void cutsALongBodyToAShortExcerpt() {
        status = 500;
        body = "<html>" + "x".repeat(5000) + "</html>";

        UnexpectedResponseException ex = assertThrows(UnexpectedResponseException.class,
                () -> client(0).contacts().get("contact_123"));

        assertTrue(ex.getBodyExcerpt().length() <= 200, String.valueOf(ex.getBodyExcerpt().length()));
    }

    @Test
    void jsonThatIsNotTheEnvelopeIsUnexpected() {
        status = 500;
        body = "{\"error\":\"boom\"}";

        UnexpectedResponseException ex = assertThrows(UnexpectedResponseException.class,
                () -> client(0).contacts().get("contact_123"));

        assertEquals("{\"error\":\"boom\"}", ex.getBodyExcerpt());
    }

    @Test
    void a2xxBodyThatIsNotJsonIsAWrongHostNotANetworkError() {
        status = 200;
        body = "<!DOCTYPE html><html><head><title>Owlat</title></head></html>";

        UnexpectedResponseException ex = assertThrows(UnexpectedResponseException.class,
                () -> client(2).contacts().get("contact_123"));

        assertEquals(200, ex.getStatusCode());
        // Nothing transient about it: one attempt.
        assertEquals(1, attempts.get());
    }

    @Test
    void stillRetriesAReplaySafeRequestOnSuchA5xx() {
        status = 503;
        body = HTML_502;

        assertThrows(UnexpectedResponseException.class,
                () -> client(2).contacts().get("contact_123"));

        assertEquals(3, attempts.get());
    }

    @Test
    void a429WithoutTheEnvelopeStaysARateLimit() {
        status = 429;
        body = "Too Many Requests";
        retryAfter = "60";

        RateLimitException ex = assertThrows(RateLimitException.class,
                () -> client(0).contacts().get("contact_123"));

        assertEquals(60, ex.getRetryAfter());
    }

    @Test
    void theEnvelopeKeepsItsTypedException() {
        status = 404;
        body = "{\"error\":{\"category\":\"not_found\",\"message\":\"Contact not found\"}}";

        NotFoundException ex = assertThrows(NotFoundException.class,
                () -> client(0).contacts().get("contact_123"));

        assertEquals("Contact not found", ex.getMessage());
    }
}
