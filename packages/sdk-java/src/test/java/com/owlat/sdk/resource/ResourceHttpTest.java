package com.owlat.sdk.resource;

import com.fasterxml.jackson.databind.JsonNode;
import com.owlat.sdk.Owlat;
import com.owlat.sdk.OwlatConfig;
import com.owlat.sdk.internal.JsonMapper;
import com.owlat.sdk.model.PaginatedResponse;
import com.owlat.sdk.model.PaginationParams;
import com.owlat.sdk.model.contact.CreateContactParams;
import com.owlat.sdk.model.contact.UpdateContactParams;
import com.owlat.sdk.model.domain.SendingDomainRecord;
import com.owlat.sdk.model.domain.SendingDomainSetup;
import com.owlat.sdk.model.event.SendEventParams;
import com.owlat.sdk.model.status.DeliveryStatus;
import com.owlat.sdk.model.status.SendingHoldLift;
import com.owlat.sdk.model.topic.AddToTopicParams;
import com.owlat.sdk.model.topic.RemoveFromTopicParams;
import com.owlat.sdk.model.topic.Topic;
import com.owlat.sdk.model.transactional.SendTransactionalParams;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;

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
    void topicsListGetsTopicsRootWithPaginationQuery() {
        responseBody = "{\"data\":[{\"id\":\"topic_1\",\"name\":\"Product updates\",\"description\":null,"
                + "\"requiresDoubleOptIn\":true,\"createdAt\":\"2026-01-10T08:00:00.000Z\"}],"
                + "\"pagination\":{\"limit\":10,\"totalItems\":11,\"cursor\":\"c2\",\"isDone\":false}}";
        PaginatedResponse<Topic> page = client().topics().list(PaginationParams.builder().limit(10).cursor("c1").build());
        assertEquals("GET", method);
        assertEquals("/api/v1/topics", rawPath);
        assertEquals("limit=10&cursor=c1", query);
        assertEquals("topic_1", page.getData().get(0).getId());
        assertTrue(page.getData().get(0).requiresDoubleOptIn());
        assertNull(page.getData().get(0).getDescription());
        assertEquals("c2", page.getPagination().getCursor());
    }

    @Test
    void topicsListWithoutParamsSendsNoQuery() {
        responseBody = "{\"data\":[],\"pagination\":{\"limit\":25,\"totalItems\":0,\"cursor\":null,\"isDone\":true}}";
        client().topics().list();
        assertEquals("/api/v1/topics", rawPath);
        assertNull(query);
    }

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

    @Test
    void transactionalGetReadsTheSendByItsId() {
        client().transactional().get("send_123");
        assertEquals("GET", method);
        assertEquals("/api/v1/transactional/send_123", rawPath);
        assertEquals("", body);
    }

    @Test
    void transactionalGetUrlEncodesTheId() {
        client().transactional().get("a/b?c");
        assertEquals("/api/v1/transactional/a%2Fb%3Fc", rawPath);
    }

    // ── domains ─────────────────────────────────────────────────────────────

    @Test
    void domainsListReadsTheDomainsRoute() {
        responseBody = "{\"data\":[{\"id\":\"d1\",\"domain\":\"news.example.com\",\"status\":\"failed\","
                + "\"lastCheckedAt\":null,\"records\":[{\"purpose\":\"mail_from\",\"type\":\"MX\","
                + "\"host\":\"bounce.news.example.com\",\"value\":\"feedback.owlat.example\",\"priority\":10,"
                + "\"state\":\"wrong\",\"foundValue\":\"10 mx.example.net\"}]}]}";
        List<SendingDomainSetup> domains = client().domains().list();
        assertEquals("GET", method);
        assertEquals("/api/v1/domains", rawPath);
        assertEquals("", body);
        assertEquals("failed", domains.get(0).getStatus());
        assertNull(domains.get(0).getLastCheckedAt());
        SendingDomainRecord record = domains.get(0).getRecords().get(0);
        assertEquals("bounce.news.example.com", record.getHost());
        assertEquals(10, record.getPriority());
        assertEquals("wrong", record.getState());
        assertEquals("10 mx.example.net", record.getFoundValue());
    }

    // ── status ──────────────────────────────────────────────────────────────

    @Test
    void statusGetReadsTheStatusRoute() {
        responseBody = "{\"data\":{\"level\":\"error\",\"reasonCode\":\"sending_suspended\","
                + "\"explanation\":\"Sending is suspended.\","
                + "\"fix\":{\"route\":\"/dashboard/admin/operator\",\"who\":\"platform_admin\"},"
                + "\"domains\":[{\"domain\":\"mail.example.com\",\"status\":\"verified\"}],"
                + "\"rates\":{\"windowDays\":30,\"sent\":1000,"
                + "\"bounce\":{\"ratePct\":6,\"limitPct\":2,\"isOver\":true},"
                + "\"complaint\":{\"ratePct\":0.05,\"limitPct\":0.1,\"isOver\":false}},"
                + "\"sendingHold\":{\"status\":\"suspended\",\"since\":\"2026-11-20T09:00:00.000Z\",\"detail\":null,"
                + "\"lift\":{\"mode\":\"automatic\",\"condition\":{\"trigger\":\"gmail_spam_rate\","
                + "\"domain\":\"mail.example.com\",\"currentPct\":0.4,\"limitPct\":0.1,\"isClear\":false,"
                + "\"clearsAt\":\"2026-12-18T00:00:00.000Z\"}}}}}";
        DeliveryStatus status = client().status().get();
        assertEquals("GET", method);
        assertEquals("/api/v1/status", rawPath);
        assertEquals("", body);
        assertEquals("sending_suspended", status.getReasonCode());
        assertEquals("platform_admin", status.getFix().getWho());
        assertEquals("verified", status.getDomains().get(0).getStatus());
        assertEquals(6.0, status.getRates().getBounce().getRatePct());
        assertTrue(status.getRates().getBounce().isOver());
        assertFalse(status.getRates().getComplaint().isOver());
        assertEquals("2026-11-20T09:00:00.000Z", status.getSendingHold().getSince());
        assertNull(status.getSendingHold().getDetail());
        SendingHoldLift lift = status.getSendingHold().getLift();
        assertEquals("automatic", lift.getMode());
        assertEquals("gmail_spam_rate", lift.getCondition().getTrigger());
        assertEquals("mail.example.com", lift.getCondition().getDomain());
        assertEquals(0.4, lift.getCondition().getCurrentPct());
        assertEquals(0.1, lift.getCondition().getLimitPct());
        assertFalse(lift.getCondition().isClear());
        assertEquals("2026-12-18T00:00:00.000Z", lift.getCondition().getClearsAt());
    }

    @Test
    void statusGetReadsAManualLiftWithoutACondition() {
        responseBody = "{\"data\":{\"level\":\"error\",\"reasonCode\":\"sending_suspended\","
                + "\"explanation\":\"Sending is suspended.\",\"fix\":null,\"domains\":[],\"rates\":null,"
                + "\"sendingHold\":{\"status\":\"suspended\",\"since\":null,\"detail\":null,"
                + "\"lift\":{\"mode\":\"admin\",\"condition\":null}}}}";
        SendingHoldLift lift = client().status().get().getSendingHold().getLift();
        assertEquals("admin", lift.getMode());
        assertNull(lift.getCondition());
    }
}
