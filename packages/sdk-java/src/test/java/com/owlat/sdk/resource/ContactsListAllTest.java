package com.owlat.sdk.resource;

import com.owlat.sdk.Owlat;
import com.owlat.sdk.OwlatConfig;
import com.owlat.sdk.model.PaginationParams;
import com.owlat.sdk.model.contact.Contact;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Behavioral tests for {@link ContactsResource#listAll}: the auto-paginating
 * stream must follow the server's cursor across pages, stop on {@code isDone},
 * fetch lazily (only the pages the caller consumes), and ignore any supplied
 * cursor — mirroring the JS SDK's {@code listAll} async iterator.
 *
 * <p>A throwaway in-process {@link HttpServer} serves three cursor-linked pages
 * and records how many list requests arrived, so laziness is observable.
 */
class ContactsListAllTest {

    private HttpServer server;
    private String baseUrl;
    private final AtomicInteger requestCount = new AtomicInteger();
    private volatile String lastQuery;

    @BeforeEach
    void start() throws IOException {
        requestCount.set(0);
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/v1/contacts", this::handle);
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    private void handle(HttpExchange exchange) throws IOException {
        requestCount.incrementAndGet();
        String query = exchange.getRequestURI().getRawQuery();
        lastQuery = query;
        String cursor = cursorFrom(query);

        // Three pages: [c1,c2] cursor=p2 → [c3,c4] cursor=p3 → [c5] isDone.
        String json;
        if (cursor == null) {
            json = page(List.of("c1", "c2"), "p2", false);
        } else if (cursor.equals("p2")) {
            json = page(List.of("c3", "c4"), "p3", false);
        } else if (cursor.equals("p3")) {
            json = page(List.of("c5"), null, true);
        } else {
            json = page(List.of(), null, true);
        }

        byte[] out = json.getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(200, out.length);
        exchange.getResponseBody().write(out);
        exchange.close();
    }

    private static String cursorFrom(String query) {
        if (query == null) {
            return null;
        }
        for (String part : query.split("&")) {
            if (part.startsWith("cursor=")) {
                return part.substring("cursor=".length());
            }
        }
        return null;
    }

    private static String page(List<String> ids, String cursor, boolean isDone) {
        String items = ids.stream()
                .map(id -> "{\"id\":\"" + id + "\",\"email\":\"" + id + "@example.com\"}")
                .collect(Collectors.joining(","));
        String cursorJson = cursor == null ? "null" : "\"" + cursor + "\"";
        return "{\"data\":[" + items + "],"
                + "\"pagination\":{\"limit\":2,\"totalItems\":5,"
                + "\"cursor\":" + cursorJson + ",\"isDone\":" + isDone + "}}";
    }

    private Owlat client() {
        return new Owlat(OwlatConfig.builder("sk_test_123").baseUrl(baseUrl).build());
    }

    @Test
    void listAllStreamsEveryContactAcrossPages() {
        List<String> ids = client().contacts().listAll()
                .map(Contact::getId)
                .collect(Collectors.toList());

        assertEquals(List.of("c1", "c2", "c3", "c4", "c5"), ids);
        // Three pages → exactly three list requests.
        assertEquals(3, requestCount.get());
    }

    @Test
    void listAllFetchesLazily() {
        // Consuming only the first two items must not fetch the later pages.
        List<String> firstTwo = client().contacts().listAll()
                .limit(2)
                .map(Contact::getId)
                .collect(Collectors.toList());

        assertEquals(List.of("c1", "c2"), firstTwo);
        assertEquals(1, requestCount.get(), "only the first page should be fetched");
    }

    @Test
    void listAllIgnoresASuppliedCursor() {
        // A cursor on the params must be ignored — iteration starts at page one.
        List<String> ids = client().contacts()
                .listAll(PaginationParams.builder().cursor("p3").limit(2).build())
                .map(Contact::getId)
                .collect(Collectors.toList());

        assertEquals(List.of("c1", "c2", "c3", "c4", "c5"), ids);
    }

    @Test
    void listAllForwardsLimitAndSearch() {
        client().contacts()
                .listAll(PaginationParams.builder().limit(2).search("ann").build())
                .findFirst();

        assertNotNull(lastQuery);
        assertTrue(lastQuery.contains("limit=2"), lastQuery);
        assertTrue(lastQuery.contains("search=ann"), lastQuery);
    }
}
