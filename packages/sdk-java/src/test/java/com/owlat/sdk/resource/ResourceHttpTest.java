package com.owlat.sdk.resource;

import com.fasterxml.jackson.databind.JsonNode;
import com.owlat.sdk.Owlat;
import com.owlat.sdk.OwlatConfig;
import com.owlat.sdk.internal.JsonMapper;
import com.owlat.sdk.model.PaginationParams;
import com.owlat.sdk.model.contact.CreateContactParams;
import com.owlat.sdk.model.contact.UpdateContactParams;
import com.owlat.sdk.model.event.SendEventParams;
import com.owlat.sdk.model.topic.AddToTopicParams;
import com.owlat.sdk.model.topic.RemoveFromTopicParams;
import com.owlat.sdk.model.transactional.SendTransactionalParams;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Wire-contract tests for the resource classes: each SDK call must hit the exact
 * v1 REST path + method + body the backend registers (apps/api/convex/http.ts).
 * The model tests cover JSON serialization; these cover the HTTP surface, which
 * previously had no coverage — a path/method regression in any resource would
 * have shipped silently.
 *
 * A throwaway in-process HttpServer records the inbound request and returns a
 * canned envelope, so no network and no running backend are needed.
 */
class ResourceHttpTest {

    private HttpServer server;
    private String baseUrl;

    // Recorded request from the most recent call.
    private volatile String method;
    private volatile String rawPath;
    private volatile String query;
    private volatile String body;
    private volatile String authorization;
    // Response the handler returns (data shape varies: object vs array).
    private volatile String responseBody = "{\"data\":{}}";

    @BeforeEach
    void start() throws IOException {
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
        method = exchange.getRequestMethod();
        rawPath = exchange.getRequestURI().getRawPath();
        query = exchange.getRequestURI().getRawQuery();
        authorization = exchange.getRequestHeaders().getFirst("Authorization");
        body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);

        byte[] out = responseBody.getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(200, out.length);
        exchange.getResponseBody().write(out);
        exchange.close();
    }

    private Owlat client() {
        return new Owlat(OwlatConfig.builder("sk_test_123").baseUrl(baseUrl).build());
    }

    private JsonNode bodyJson() throws IOException {
        return JsonMapper.instance().readTree(body);
    }

    // ── contacts ────────────────────────────────────────────────────────────

    @Test
    void contactsCreatePostsToContactsRoot() throws IOException {
        client().contacts().create(CreateContactParams.builder("alice@example.com").firstName("Alice").build());
        assertEquals("POST", method);
        assertEquals("/api/v1/contacts", rawPath);
        assertEquals("alice@example.com", bodyJson().get("email").asText());
        assertEquals("Bearer sk_test_123", authorization);
    }

    @Test
    void contactsGetUsesIdInPath() {
        client().contacts().get("contact_123");
        assertEquals("GET", method);
        assertEquals("/api/v1/contacts/contact_123", rawPath);
    }

    @Test
    void contactsGetUrlEncodesAnEmailIdentifier() {
        client().contacts().get("a+b@example.com");
        assertEquals("GET", method);
        // '+' → %2B and '@' → %40 so the path segment is unambiguous.
        assertEquals("/api/v1/contacts/a%2Bb%40example.com", rawPath);
    }

    @Test
    void contactsUpdatePutsToIdPath() throws IOException {
        client().contacts().update("contact_123", UpdateContactParams.builder().firstName("Bob").build());
        assertEquals("PUT", method);
        assertEquals("/api/v1/contacts/contact_123", rawPath);
        assertEquals("Bob", bodyJson().get("firstName").asText());
    }

    @Test
    void contactsDeleteDeletesIdPath() {
        client().contacts().delete("contact_123");
        assertEquals("DELETE", method);
        assertEquals("/api/v1/contacts/contact_123", rawPath);
    }

    @Test
    void contactsListGetsContactsRootWithPaginationQuery() {
        responseBody = "{\"data\":[]}";
        client().contacts().list(PaginationParams.builder().limit(10).cursor("c1").search("ann").build());
        assertEquals("GET", method);
        assertEquals("/api/v1/contacts", rawPath);
        assertNotNull(query);
        assertTrue(query.contains("limit=10"), query);
        assertTrue(query.contains("cursor=c1"), query);
        assertTrue(query.contains("search=ann"), query);
    }

    // ── topics ──────────────────────────────────────────────────────────────

    @Test
    void topicsAddContactPostsToTopicContactsPath() throws IOException {
        client().topics().addContact(AddToTopicParams.builder("topic_42").email("user@example.com").build());
        assertEquals("POST", method);
        assertEquals("/api/v1/topics/topic_42/contacts", rawPath);
        assertEquals("user@example.com", bodyJson().get("email").asText());
    }

    @Test
    void topicsRemoveContactDeletesTopicContactPath() {
        client().topics().removeContact(new RemoveFromTopicParams("topic_42", "user@example.com"));
        assertEquals("DELETE", method);
        assertEquals("/api/v1/topics/topic_42/contacts/user%40example.com", rawPath);
    }

    // ── events ──────────────────────────────────────────────────────────────

    @Test
    void eventsSendPostsToEventsRoot() throws IOException {
        client().events().send(SendEventParams.builder("user@example.com", "signup_completed").build());
        assertEquals("POST", method);
        assertEquals("/api/v1/events", rawPath);
        assertEquals("signup_completed", bodyJson().get("eventName").asText());
    }

    // ── transactional ─────────────────────────────────────────────────────────

    @Test
    void transactionalSendPostsToTransactionalRoot() throws IOException {
        client().transactional().send(SendTransactionalParams.builder("user@example.com").slug("welcome").build());
        assertEquals("POST", method);
        assertEquals("/api/v1/transactional", rawPath);
        assertEquals("user@example.com", bodyJson().get("email").asText());
        assertEquals("welcome", bodyJson().get("slug").asText());
    }
}
