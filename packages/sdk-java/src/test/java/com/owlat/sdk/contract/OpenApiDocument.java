package com.owlat.sdk.contract;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The public API's OpenAPI document, generated from
 * {@code packages/public-contract} and committed beside it. Maven runs from
 * this module's directory; the {@code owlat.openapi} system property points
 * elsewhere when needed.
 */
final class OpenApiDocument {

    /** One operation of the document. */
    static final class Operation {
        final String id;
        final String method;
        final String path;
        final JsonNode node;

        Operation(String id, String method, String path, JsonNode node) {
            this.id = id;
            this.method = method;
            this.path = path;
            this.node = node;
        }

        /** The documented success status: the one 2xx response. */
        int successStatus() {
            Iterator<String> statuses = node.get("responses").fieldNames();
            while (statuses.hasNext()) {
                String status = statuses.next();
                if (status.startsWith("2")) return Integer.parseInt(status);
            }
            throw new IllegalStateException(id + " documents no success response");
        }

        JsonNode successContent() {
            return node.get("responses").get(String.valueOf(successStatus())).get("content").get("application/json");
        }

        /** The request body's schema, or null for an operation without one. */
        JsonNode requestSchema() {
            JsonNode body = node.path("requestBody").path("content").path("application/json").path("schema");
            return body.isMissingNode() ? null : body;
        }

        /** Whether a concrete request path fits this operation's path template. */
        boolean matchesPath(String rawPath) {
            return rawPath.matches(path.replaceAll("\\{\\w+}", "[^/]+"));
        }
    }

    final JsonNode root;

    private OpenApiDocument(JsonNode root) {
        this.root = root;
    }

    static OpenApiDocument load() throws IOException {
        Path file = Path.of(System.getProperty("owlat.openapi", "../public-contract/openapi.json"));
        return of(new ObjectMapper().readTree(Files.readString(file)));
    }

    static OpenApiDocument of(JsonNode root) {
        return new OpenApiDocument(root);
    }

    /** Every operation, keyed by operationId, in document order. */
    Map<String, Operation> operations() {
        Map<String, Operation> operations = new LinkedHashMap<>();
        Iterator<Map.Entry<String, JsonNode>> paths = root.get("paths").fields();
        while (paths.hasNext()) {
            Map.Entry<String, JsonNode> path = paths.next();
            Iterator<Map.Entry<String, JsonNode>> methods = path.getValue().fields();
            while (methods.hasNext()) {
                Map.Entry<String, JsonNode> method = methods.next();
                String id = method.getValue().get("operationId").asText();
                operations.put(id, new Operation(id, method.getKey().toUpperCase(), path.getKey(), method.getValue()));
            }
        }
        return operations;
    }

    Operation operation(String id) {
        Operation operation = operations().get(id);
        if (operation == null) throw new AssertionError("The contract documents no operation " + id);
        return operation;
    }
}
