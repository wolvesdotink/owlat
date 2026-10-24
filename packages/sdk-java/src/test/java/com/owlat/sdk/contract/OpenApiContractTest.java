package com.owlat.sdk.contract;

import com.fasterxml.jackson.annotation.JsonAutoDetect;
import com.fasterxml.jackson.annotation.PropertyAccessor;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JavaType;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.owlat.sdk.Owlat;
import com.owlat.sdk.OwlatConfig;
import com.owlat.sdk.RequestOptions;
import com.owlat.sdk.internal.JsonMapper;
import com.owlat.sdk.model.PaginatedResponse;
import com.owlat.sdk.model.PaginationParams;
import com.owlat.sdk.model.contact.Contact;
import com.owlat.sdk.model.contact.CreateContactParams;
import com.owlat.sdk.model.contact.DeleteContactResponse;
import com.owlat.sdk.model.contact.UpdateContactParams;
import com.owlat.sdk.model.event.SendEventParams;
import com.owlat.sdk.model.event.SendEventResponse;
import com.owlat.sdk.model.topic.AddToTopicParams;
import com.owlat.sdk.model.topic.AddToTopicResponse;
import com.owlat.sdk.model.topic.RemoveFromTopicParams;
import com.owlat.sdk.model.topic.RemoveFromTopicResponse;
import com.owlat.sdk.model.transactional.SendTransactionalParams;
import com.owlat.sdk.model.transactional.SendTransactionalResponse;
import com.owlat.sdk.model.transactional.TransactionalAttachment;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.Function;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;

/**
 * The SDK against the public API contract: the OpenAPI document generated from
 * {@code packages/public-contract}, the same source the server validates with.
 *
 * <p>Each SDK call goes to an in-process server that answers with the
 * operation's documented example. The test then checks that the call used the
 * documented method and path, that the body the SDK put on the wire satisfies
 * the request schema (closed: no field the contract does not document), and
 * that the example reads into the SDK's model with unknown fields refused and
 * writes back to the same JSON, so a field that is missing, renamed or of a
 * different type in the model fails. The drift tests at the bottom prove each
 * of those checks fails when the contract and the SDK disagree.
 */
class OpenApiContractTest {

    /** One SDK call for an operation, and the model type its response body reads into. */
    private static final class Call {
        final Function<Owlat, Object> invoke;
        final Function<ObjectMapper, JavaType> responseType;
        final boolean wholeBody;

        Call(Function<Owlat, Object> invoke, Function<ObjectMapper, JavaType> responseType, boolean wholeBody) {
            this.invoke = invoke;
            this.responseType = responseType;
            this.wholeBody = wholeBody;
        }
    }

    private static final String CONTACT_ID = "k57c0ntact00000000000000000000";
    private static final String TOPIC_ID = "k57t0pic0000000000000000000000";

    private static Function<ObjectMapper, JavaType> type(Class<?> model) {
        return mapper -> mapper.constructType(model);
    }

    /** Every keyed operation's SDK call, with every optional field the SDK can send filled in. */
    private static Map<String, Call> calls() {
        Map<String, Call> calls = new LinkedHashMap<>();
        calls.put("listContacts", new Call(
                owlat -> owlat.contacts().list(PaginationParams.builder().limit(25).cursor("c1").search("ada").build()),
                mapper -> mapper.getTypeFactory().constructParametricType(PaginatedResponse.class, Contact.class),
                true));
        calls.put("createContact", new Call(
                owlat -> owlat.contacts().create(
                        CreateContactParams.builder("ada@example.com").firstName("Ada").lastName("Lovelace").build()),
                type(Contact.class), false));
        calls.put("getContact", new Call(owlat -> owlat.contacts().get(CONTACT_ID), type(Contact.class), false));
        calls.put("updateContact", new Call(
                owlat -> owlat.contacts().update("ada@example.com", UpdateContactParams.builder()
                        .email("ada@example.com").firstName("Ada").lastName("Lovelace").build()),
                type(Contact.class), false));
        calls.put("deleteContact", new Call(
                owlat -> owlat.contacts().delete(CONTACT_ID), type(DeleteContactResponse.class), false));
        calls.put("sendEvent", new Call(
                owlat -> owlat.events().send(SendEventParams.builder("ada@example.com", "signup_completed")
                        .eventProperties(primitiveRecord())
                        .createContactIfNotExists(true)
                        .build(), RequestOptions.idempotencyKey("order-1001-signup")),
                type(SendEventResponse.class), false));
        calls.put("sendTransactional", new Call(
                owlat -> owlat.transactional().send(SendTransactionalParams.builder("ada@example.com")
                        .transactionalId("k57t3mpl4te0000000000000000000")
                        .slug("order-confirmation")
                        .dataVariables(primitiveRecord())
                        .language("en-US")
                        .attachment(TransactionalAttachment.builder("invoice.pdf")
                                .content("JVBERi0xLjQK").contentType("application/pdf").build())
                        .attachment(TransactionalAttachment.builder("terms.pdf")
                                .url("https://owlat.example/terms.pdf").build())
                        .build(), RequestOptions.idempotencyKey("order-1001-confirmation")),
                type(SendTransactionalResponse.class), false));
        calls.put("addContactToTopic", new Call(
                owlat -> owlat.topics().addContact(
                        AddToTopicParams.builder(TOPIC_ID).email("ada@example.com").contactId(CONTACT_ID).build()),
                type(AddToTopicResponse.class), false));
        calls.put("removeContactFromTopic", new Call(
                owlat -> owlat.topics().removeContact(new RemoveFromTopicParams(TOPIC_ID, "ada@example.com")),
                type(RemoveFromTopicResponse.class), false));
        return calls;
    }

    private static Map<String, Object> primitiveRecord() {
        Map<String, Object> values = new LinkedHashMap<>();
        values.put("plan", "pro");
        values.put("seats", 3);
        values.put("total", 42.5);
        values.put("trial", false);
        return values;
    }

    private OpenApiDocument document;
    private HttpServer server;
    private String baseUrl;

    // The recorded request and the canned answer.
    private volatile String method;
    private volatile String rawPath;
    private volatile String rawQuery;
    private volatile String body;
    private volatile Map<String, String> headers;
    private volatile int status = 200;
    private volatile String responseBody = "{}";

    @BeforeEach
    void start() throws IOException {
        document = OpenApiDocument.load();
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
        rawQuery = exchange.getRequestURI().getRawQuery();
        body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        Map<String, String> seen = new LinkedHashMap<>();
        exchange.getRequestHeaders().forEach((name, values) -> seen.put(name.toLowerCase(), values.get(0)));
        headers = seen;
        byte[] out = responseBody.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, out.length);
        exchange.getResponseBody().write(out);
        exchange.close();
    }

    private Owlat client() {
        return new Owlat(OwlatConfig.builder("lm_live_test").baseUrl(baseUrl).build());
    }

    // ── coverage ────────────────────────────────────────────────────────────

    /** Keyed operations the document lists that have no SDK call. */
    static Set<String> uncovered(OpenApiDocument document, Set<String> covered) {
        Set<String> missing = new TreeSet<>();
        for (OpenApiDocument.Operation operation : document.operations().values()) {
            boolean keyed = operation.node.path("security").size() > 0;
            if (keyed && !covered.contains(operation.id)) missing.add(operation.id);
        }
        return missing;
    }

    @Test
    void everyKeyedOperationHasAnSdkCall() {
        assertEquals(Set.of(), uncovered(document, calls().keySet()));
        for (String id : calls().keySet()) document.operation(id);
    }

    // ── each call against its operation ─────────────────────────────────────

    @TestFactory
    Stream<DynamicTest> everyCallMatchesItsOperation() {
        return calls().entrySet().stream().map(entry -> DynamicTest.dynamicTest(entry.getKey(), () -> {
            OpenApiDocument.Operation operation = document.operation(entry.getKey());
            List<String> problems = checkCall(document, operation, entry.getValue());
            assertEquals(List.of(), problems);
        }));
    }

    /** Every way one SDK call disagrees with its documented operation. */
    private List<String> checkCall(OpenApiDocument document, OpenApiDocument.Operation operation, Call call)
            throws IOException {
        List<String> problems = new ArrayList<>();
        JsonNode example = operation.successContent().get("example");
        status = operation.successStatus();
        responseBody = JsonMapper.instance().writeValueAsString(example);
        Object result = call.invoke.apply(client());

        if (!operation.method.equals(method)) problems.add("method " + method + ", documented " + operation.method);
        if (!operation.matchesPath(rawPath)) problems.add("path " + rawPath + ", documented " + operation.path);

        JsonNode requestSchema = operation.requestSchema();
        if (requestSchema != null) {
            JsonNode sent = JsonMapper.instance().readTree(body);
            problems.addAll(new SchemaValidator(document.root, true).validate(requestSchema, sent));
        } else if (!body.isEmpty()) {
            problems.add("sent a body the operation does not take: " + body);
        }
        problems.addAll(checkParameters(operation));

        JsonNode expected = call.wholeBody ? example : example.get("data");
        problems.addAll(readBack(call, expected, result));
        return problems;
    }

    /** Query parameters and headers the call sent that the operation does not document, or sent wrongly. */
    private List<String> checkParameters(OpenApiDocument.Operation operation) {
        List<String> problems = new ArrayList<>();
        Map<String, JsonNode> documented = new LinkedHashMap<>();
        for (JsonNode parameter : operation.node.path("parameters")) {
            documented.put(parameter.get("in").asText() + ":" + parameter.get("name").asText().toLowerCase(), parameter);
        }
        if (rawQuery != null) {
            for (String pair : rawQuery.split("&")) {
                String name = pair.split("=", 2)[0];
                if (!documented.containsKey("query:" + name.toLowerCase())) problems.add("undocumented query parameter " + name);
            }
        }
        for (Map.Entry<String, JsonNode> parameter : documented.entrySet()) {
            if (!parameter.getKey().startsWith("header:")) continue;
            String value = headers.get(parameter.getKey().substring("header:".length()));
            if (value == null) {
                problems.add("did not send the documented header " + parameter.getValue().get("name").asText());
                continue;
            }
            problems.addAll(new SchemaValidator(document.root, true)
                    .validate(parameter.getValue().get("schema"), JsonMapper.instance().getNodeFactory().textNode(value)));
        }
        return problems;
    }

    /**
     * Read the example into the model with unknown fields refused, then write the
     * model back and compare: a field the model lacks, renames or holds as a
     * different type shows up as a difference. The model writes no nulls, so the
     * example's null fields are left out of the comparison; the strict read has
     * already proved the model knows them.
     */
    static List<String> readBack(Call call, JsonNode expected, Object resultFromClient) {
        List<String> problems = new ArrayList<>();
        ObjectMapper strict = JsonMapper.instance().copy()
                .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, true)
                .configure(DeserializationFeature.ACCEPT_FLOAT_AS_INT, false);
        ObjectMapper fields = JsonMapper.instance().copy()
                .setVisibility(PropertyAccessor.ALL, JsonAutoDetect.Visibility.NONE)
                .setVisibility(PropertyAccessor.FIELD, JsonAutoDetect.Visibility.ANY);
        Object model;
        try {
            model = strict.readValue(strict.treeAsTokens(expected), call.responseType.apply(strict));
        } catch (IOException e) {
            problems.add("the model cannot read the documented response: " + e.getMessage());
            return problems;
        }
        JsonNode written = fields.valueToTree(model);
        JsonNode wanted = withoutNulls(expected);
        if (!wanted.equals(written)) problems.add("model writes " + written + ", documented " + wanted);
        if (resultFromClient != null && !written.equals(fields.valueToTree(resultFromClient))) {
            problems.add("the client returned something other than the documented response");
        }
        return problems;
    }

    private static JsonNode withoutNulls(JsonNode node) {
        if (node.isObject()) {
            ObjectNode out = JsonMapper.instance().createObjectNode();
            Iterator<Map.Entry<String, JsonNode>> fields = node.fields();
            while (fields.hasNext()) {
                Map.Entry<String, JsonNode> field = fields.next();
                if (!field.getValue().isNull()) out.set(field.getKey(), withoutNulls(field.getValue()));
            }
            return out;
        }
        if (node.isArray()) {
            ArrayNode out = JsonMapper.instance().createArrayNode();
            for (JsonNode item : node) out.add(withoutNulls(item));
            return out;
        }
        return node;
    }

    @Test
    void everyDocumentedDoiStatusReadsIntoTheModel() throws IOException {
        JsonNode statuses = document.root.at("/components/schemas/AddToTopicResponse/properties/doiStatus/enum");
        assertTrue(statuses.size() > 0);
        for (JsonNode value : statuses) {
            ObjectNode response = (ObjectNode) document.operation("addContactToTopic").successContent().get("example").get("data").deepCopy();
            response.set("doiStatus", value);
            assertEquals(List.of(), readBack(calls().get("addContactToTopic"), response, null), value.asText());
        }
    }

    // ── the checks fail when the two sides disagree ─────────────────────────

    private OpenApiDocument mutated(String pointer, Function<ObjectNode, Object> change) {
        JsonNode copy = document.root.deepCopy();
        change.apply((ObjectNode) copy.at(pointer));
        return OpenApiDocument.of(copy);
    }

    @Test
    void aMissingOperationIsCaught() {
        OpenApiDocument extended = mutated("/paths", paths -> paths.set("/api/v1/segments",
                JsonMapper.instance().createObjectNode().set("get", JsonMapper.instance().createObjectNode()
                        .put("operationId", "listSegments")
                        .set("security", JsonMapper.instance().createArrayNode().add(JsonMapper.instance().createObjectNode())))));
        assertEquals(Set.of("listSegments"), uncovered(extended, calls().keySet()));
    }

    @Test
    void aNewRequiredRequestFieldIsCaught() throws IOException {
        OpenApiDocument stricter = mutated("/components/schemas/CreateContactRequest",
                schema -> ((ArrayNode) schema.get("required")).add("phone"));
        List<String> problems = checkCall(stricter, stricter.operation("createContact"), calls().get("createContact"));
        assertTrue(problems.stream().anyMatch(p -> p.contains("missing required field 'phone'")), problems.toString());
    }

    @Test
    void aFieldTheContractDoesNotDocumentIsCaught() throws IOException {
        OpenApiDocument narrower = mutated("/components/schemas/CreateContactRequest/properties",
                properties -> properties.remove("lastName"));
        List<String> problems = checkCall(narrower, narrower.operation("createContact"), calls().get("createContact"));
        assertTrue(problems.stream().anyMatch(p -> p.contains("lastName: not a documented field")), problems.toString());
    }

    @Test
    void aChangedResponseFieldTypeIsCaught() throws IOException {
        ObjectNode response = (ObjectNode) document.operation("sendEvent").successContent().get("example").get("data").deepCopy();
        response.put("triggeredAutomations", "2");
        assertFalse(readBack(calls().get("sendEvent"), response, null).isEmpty());
    }

    @Test
    void aResponseFieldTheModelLacksIsCaught() throws IOException {
        ObjectNode response = (ObjectNode) document.operation("getContact").successContent().get("example").get("data").deepCopy();
        response.put("phone", "+15550100");
        assertFalse(readBack(calls().get("getContact"), response, null).isEmpty());
    }

    @Test
    void aNestedVariableValueIsOutsideTheContract() throws IOException {
        JsonNode schema = document.root.at("/components/schemas/SendTransactionalRequest");
        ObjectNode request = JsonMapper.instance().createObjectNode().put("email", "ada@example.com").put("slug", "welcome");
        request.set("dataVariables", JsonMapper.instance().createObjectNode()
                .set("order", JsonMapper.instance().createObjectNode().put("id", 1)));
        assertFalse(new SchemaValidator(document.root, true).validate(schema, request).isEmpty());
    }
}
