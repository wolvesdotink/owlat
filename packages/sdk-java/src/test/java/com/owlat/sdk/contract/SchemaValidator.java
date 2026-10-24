package com.owlat.sdk.contract;

import com.fasterxml.jackson.databind.JsonNode;

import com.fasterxml.jackson.databind.node.TextNode;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * A JSON Schema check for the subset of JSON Schema 2020-12 the generated
 * OpenAPI document uses: {@code $ref} into {@code components/schemas},
 * {@code type} (one or a list), {@code properties}, {@code required},
 * {@code additionalProperties}, {@code propertyNames}, {@code items},
 * {@code enum}, {@code const}, {@code anyOf}, {@code oneOf}, string length and
 * {@code pattern}, numeric bounds and array length. Before any value is
 * checked, the whole schema is walked, every subschema and every
 * {@code $ref} target included: a keyword outside that subset anywhere fails
 * the check, even under a branch or a field the value never reaches, so the
 * document cannot grow a rule these tests silently ignore.
 *
 * <p>With {@code closed} set, an object schema (one that declares
 * {@code type: object}) that does not mention {@code additionalProperties} is
 * treated as closed: the SDK must send only fields the contract documents,
 * even though the server ignores unknown ones. A schema without a type, such
 * as an {@code anyOf} branch constraining one field, is not closed.
 */
final class SchemaValidator {

    private static final List<String> KNOWN = List.of(
            "$ref", "type", "properties", "required", "additionalProperties", "propertyNames",
            "items", "enum", "const", "anyOf", "oneOf", "minLength", "maxLength", "pattern",
            "minimum", "maximum", "minItems", "maxItems", "description", "default");

    private final JsonNode document;
    private final boolean closed;

    SchemaValidator(JsonNode document, boolean closed) {
        this.document = document;
        this.closed = closed;
    }

    /** Every way {@code value} breaks {@code schema}; empty when it conforms. */
    List<String> validate(JsonNode schema, JsonNode value) {
        requireSupported(schema, "$", new HashSet<>());
        List<String> errors = new ArrayList<>();
        check(schema, value, "$", errors);
        return errors;
    }

    private JsonNode resolve(JsonNode schema) {
        JsonNode ref = schema.get("$ref");
        if (ref == null) return schema;
        String pointer = ref.asText();
        if (!pointer.startsWith("#/")) throw new IllegalArgumentException("Unsupported $ref " + pointer);
        JsonNode target = document.at(pointer.substring(1));
        if (target.isMissingNode()) throw new IllegalArgumentException("Dangling $ref " + pointer);
        return target;
    }

    /** Throw unless {@code schema} and every schema inside it use only the supported keywords. */
    private void requireSupported(JsonNode schema, String path, Set<String> seenRefs) {
        if (!schema.isObject()) throw new IllegalArgumentException("Schema at " + path + " is not an object");
        Iterator<String> keywords = schema.fieldNames();
        while (keywords.hasNext()) {
            String keyword = keywords.next();
            if (!KNOWN.contains(keyword)) {
                throw new IllegalArgumentException("Unsupported schema keyword '" + keyword + "' at " + path);
            }
        }
        if (schema.has("$ref")) {
            if (schema.size() > 1) throw new IllegalArgumentException("Keywords beside $ref at " + path);
            String pointer = schema.get("$ref").asText();
            if (seenRefs.add(pointer)) requireSupported(resolve(schema), pointer, seenRefs);
            return;
        }
        Iterator<Map.Entry<String, JsonNode>> properties = schema.path("properties").fields();
        while (properties.hasNext()) {
            Map.Entry<String, JsonNode> property = properties.next();
            requireSupported(property.getValue(), path + ".properties." + property.getKey(), seenRefs);
        }
        JsonNode additional = schema.get("additionalProperties");
        if (additional != null && !additional.isBoolean()) {
            requireSupported(additional, path + ".additionalProperties", seenRefs);
        }
        for (String keyword : List.of("propertyNames", "items")) {
            if (schema.has(keyword)) requireSupported(schema.get(keyword), path + "." + keyword, seenRefs);
        }
        for (String keyword : List.of("anyOf", "oneOf")) {
            if (!schema.has(keyword)) continue;
            for (int i = 0; i < schema.get(keyword).size(); i++) {
                requireSupported(schema.get(keyword).get(i), path + "." + keyword + "[" + i + "]", seenRefs);
            }
        }
    }

    private void check(JsonNode rawSchema, JsonNode value, String path, List<String> errors) {
        JsonNode schema = resolve(rawSchema);

        if (schema.has("type") && !matchesType(schema.get("type"), value)) {
            errors.add(path + ": expected " + schema.get("type") + " but was " + describe(value));
            return;
        }
        if (schema.has("const") && !schema.get("const").equals(value)) {
            errors.add(path + ": expected " + schema.get("const") + " but was " + value);
        }
        if (schema.has("enum")) {
            boolean found = false;
            for (JsonNode option : schema.get("enum")) found |= option.equals(value);
            if (!found) errors.add(path + ": " + value + " is not one of " + schema.get("enum"));
        }
        if (schema.has("anyOf")) {
            boolean any = false;
            for (JsonNode option : schema.get("anyOf")) any |= validate(option, value).isEmpty();
            if (!any) errors.add(path + ": matches none of anyOf");
        }
        if (schema.has("oneOf")) {
            int matches = 0;
            for (JsonNode option : schema.get("oneOf")) if (validate(option, value).isEmpty()) matches++;
            if (matches != 1) errors.add(path + ": matches " + matches + " of oneOf, expected exactly 1");
        }
        if (value.isTextual()) checkString(schema, value.asText(), path, errors);
        if (value.isNumber()) checkNumber(schema, value, path, errors);
        if (value.isArray()) checkArray(schema, value, path, errors);
        if (value.isObject()) checkObject(schema, value, path, errors);
    }

    private void checkString(JsonNode schema, String text, String path, List<String> errors) {
        int length = text.codePointCount(0, text.length());
        if (schema.has("minLength") && length < schema.get("minLength").asInt()) {
            errors.add(path + ": shorter than " + schema.get("minLength"));
        }
        if (schema.has("maxLength") && length > schema.get("maxLength").asInt()) {
            errors.add(path + ": longer than " + schema.get("maxLength"));
        }
        if (schema.has("pattern") && !Pattern.compile(schema.get("pattern").asText()).matcher(text).find()) {
            errors.add(path + ": '" + text + "' does not match " + schema.get("pattern"));
        }
    }

    private void checkNumber(JsonNode schema, JsonNode value, String path, List<String> errors) {
        if (schema.has("minimum") && value.decimalValue().compareTo(schema.get("minimum").decimalValue()) < 0) {
            errors.add(path + ": below " + schema.get("minimum"));
        }
        if (schema.has("maximum") && value.decimalValue().compareTo(schema.get("maximum").decimalValue()) > 0) {
            errors.add(path + ": above " + schema.get("maximum"));
        }
    }

    private void checkArray(JsonNode schema, JsonNode value, String path, List<String> errors) {
        if (schema.has("minItems") && value.size() < schema.get("minItems").asInt()) {
            errors.add(path + ": fewer than " + schema.get("minItems") + " items");
        }
        if (schema.has("maxItems") && value.size() > schema.get("maxItems").asInt()) {
            errors.add(path + ": more than " + schema.get("maxItems") + " items");
        }
        if (schema.has("items")) {
            for (int i = 0; i < value.size(); i++) check(schema.get("items"), value.get(i), path + "[" + i + "]", errors);
        }
    }

    private void checkObject(JsonNode schema, JsonNode value, String path, List<String> errors) {
        JsonNode properties = schema.path("properties");
        if (schema.has("required")) {
            for (JsonNode name : schema.get("required")) {
                if (!value.has(name.asText())) errors.add(path + ": missing required field '" + name.asText() + "'");
            }
        }
        JsonNode propertyNames = schema.get("propertyNames");
        Iterator<Map.Entry<String, JsonNode>> fields = value.fields();
        while (fields.hasNext()) {
            Map.Entry<String, JsonNode> field = fields.next();
            String fieldPath = path + "." + field.getKey();
            if (propertyNames != null) {
                check(propertyNames, TextNode.valueOf(field.getKey()), fieldPath + " (name)", errors);
            }
            if (properties.has(field.getKey())) {
                check(properties.get(field.getKey()), field.getValue(), fieldPath, errors);
                continue;
            }
            JsonNode additional = schema.get("additionalProperties");
            if (additional == null) {
                if (closed && schema.has("properties") && declaresObject(schema)) {
                    errors.add(fieldPath + ": not a documented field");
                }
            } else if (additional.isBoolean()) {
                if (!additional.asBoolean()) errors.add(fieldPath + ": not a documented field");
            } else {
                check(additional, field.getValue(), fieldPath, errors);
            }
        }
    }

    private static boolean declaresObject(JsonNode schema) {
        JsonNode type = schema.path("type");
        if (type.isArray()) {
            for (JsonNode option : type) if ("object".equals(option.asText())) return true;
            return false;
        }
        return "object".equals(type.asText());
    }

    private static boolean matchesType(JsonNode type, JsonNode value) {
        if (type.isArray()) {
            for (JsonNode option : type) if (matchesType(option, value)) return true;
            return false;
        }
        switch (type.asText()) {
            case "string": return value.isTextual();
            case "number": return value.isNumber();
            case "integer": return value.isIntegralNumber();
            case "boolean": return value.isBoolean();
            case "null": return value.isNull();
            case "object": return value.isObject();
            case "array": return value.isArray();
            default: throw new IllegalArgumentException("Unknown type " + type);
        }
    }

    private static String describe(JsonNode value) {
        return value.getNodeType().name().toLowerCase() + " " + value;
    }
}
