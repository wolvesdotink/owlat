package com.owlat.sdk.model.transactional;

import com.fasterxml.jackson.databind.JsonNode;
import com.owlat.sdk.internal.JsonMapper;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class SendTransactionalParamsTest {

    @Test
    void builderCreatesParamsWithAttachments() {
        TransactionalAttachment attachment = TransactionalAttachment.builder("invoice.pdf")
                .content("base64data")
                .contentType("application/pdf")
                .build();

        SendTransactionalParams params = SendTransactionalParams.builder("user@example.com")
                .slug("order-confirmation")
                .attachment(attachment)
                .build();

        assertEquals("user@example.com", params.getEmail());
        assertEquals("order-confirmation", params.getSlug());
        assertNotNull(params.getAttachments());
        assertEquals(1, params.getAttachments().size());
        assertEquals("invoice.pdf", params.getAttachments().get(0).getFilename());
    }

    @Test
    void builderCreatesParamsWithAttachmentsList() {
        List<TransactionalAttachment> attachments = List.of(
                TransactionalAttachment.builder("file1.pdf").content("data1").build(),
                TransactionalAttachment.builder("file2.pdf").url("https://example.com/file2.pdf").build()
        );

        SendTransactionalParams params = SendTransactionalParams.builder("user@example.com")
                .slug("welcome")
                .attachments(attachments)
                .build();

        assertEquals(2, params.getAttachments().size());
    }

    @Test
    void builderThrowsWhenNeitherSlugNorTransactionalId() {
        assertThrows(IllegalArgumentException.class, () ->
                SendTransactionalParams.builder("user@example.com").build()
        );
    }

    @Test
    void dataVariablesAcceptMixedTypes() {
        Map<String, Object> vars = new LinkedHashMap<>();
        vars.put("name", "Ada");
        vars.put("orderCount", 42);
        vars.put("isPremium", true);

        SendTransactionalParams params = SendTransactionalParams.builder("user@example.com")
                .slug("welcome")
                .dataVariables(vars)
                .build();

        assertEquals("Ada", params.getDataVariables().get("name"));
        assertEquals(42, params.getDataVariables().get("orderCount"));
        assertEquals(true, params.getDataVariables().get("isPremium"));
    }

    @Test
    void dataVariablesSerializeAsJsonPrimitives() throws Exception {
        Map<String, Object> vars = new LinkedHashMap<>();
        vars.put("name", "Ada");
        vars.put("orderCount", 42);
        vars.put("balance", 12.5);
        vars.put("isPremium", true);

        SendTransactionalParams params = SendTransactionalParams.builder("user@example.com")
                .slug("welcome")
                .dataVariables(vars)
                .build();

        JsonNode root = JsonMapper.instance().valueToTree(params);
        JsonNode data = root.get("dataVariables");

        assertNotNull(data);
        // String stays a JSON string.
        assertTrue(data.get("name").isTextual());
        assertEquals("Ada", data.get("name").asText());
        // Integer serializes as a JSON number, not a quoted string.
        assertTrue(data.get("orderCount").isNumber());
        assertFalse(data.get("orderCount").isTextual());
        assertEquals(42, data.get("orderCount").asInt());
        // Double serializes as a JSON number.
        assertTrue(data.get("balance").isNumber());
        assertEquals(12.5, data.get("balance").asDouble());
        // Boolean serializes as a JSON boolean, not "true".
        assertTrue(data.get("isPremium").isBoolean());
        assertFalse(data.get("isPremium").isTextual());
        assertTrue(data.get("isPremium").asBoolean());
    }

    @Test
    void builderThrowsWhenMoreThan10Attachments() {
        SendTransactionalParams.Builder builder = SendTransactionalParams.builder("user@example.com")
                .slug("welcome");

        for (int i = 0; i < 11; i++) {
            builder.attachment(
                    TransactionalAttachment.builder("file" + i + ".txt").content("data").build()
            );
        }

        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class, builder::build);
        assertEquals("Maximum 10 attachments allowed", ex.getMessage());
    }

    // ── attachment guards (ported from sdk-js src/resources/transactional.ts) ──

    @Test
    void builderRejectsDangerousMimeType() {
        SendTransactionalParams.Builder builder = SendTransactionalParams.builder("user@example.com")
                .slug("welcome")
                .attachment(TransactionalAttachment.builder("setup.exe")
                        .content("QUJD")
                        .contentType("application/x-msdownload")
                        .build());

        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class, builder::build);
        assertEquals(
                "Attachment \"setup.exe\" has a disallowed content type: application/x-msdownload",
                ex.getMessage());
    }

    @Test
    void builderRejectsDangerousMimeTypeCaseInsensitively() {
        SendTransactionalParams.Builder builder = SendTransactionalParams.builder("user@example.com")
                .slug("welcome")
                .attachment(TransactionalAttachment.builder("run.sh")
                        .content("QUJD")
                        .contentType("Application/X-SH")
                        .build());

        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class, builder::build);
        assertTrue(ex.getMessage().contains("disallowed content type"), ex.getMessage());
    }

    @Test
    void builderRejectsInvalidBase64Content() {
        SendTransactionalParams.Builder builder = SendTransactionalParams.builder("user@example.com")
                .slug("welcome")
                .attachment(TransactionalAttachment.builder("doc.pdf")
                        // '!' and ' ' are outside the base64 alphabet.
                        .content("not valid base64!")
                        .build());

        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class, builder::build);
        assertEquals("Attachment \"doc.pdf\" has invalid base64 content", ex.getMessage());
    }

    @Test
    void builderAcceptsValidBase64WithPadding() {
        SendTransactionalParams params = SendTransactionalParams.builder("user@example.com")
                .slug("welcome")
                .attachment(TransactionalAttachment.builder("doc.pdf")
                        .content("SGVsbG8=")
                        .contentType("application/pdf")
                        .build())
                .build();

        assertEquals(1, params.getAttachments().size());
    }

    @Test
    void builderRejectsNonHttpsAttachmentUrl() {
        SendTransactionalParams.Builder builder = SendTransactionalParams.builder("user@example.com")
                .slug("welcome")
                .attachment(TransactionalAttachment.builder("report.pdf")
                        .url("http://example.com/report.pdf")
                        .build());

        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class, builder::build);
        assertEquals("Attachment \"report.pdf\" URL must use HTTPS", ex.getMessage());
    }

    @Test
    void builderAcceptsHttpsAttachmentUrl() {
        SendTransactionalParams params = SendTransactionalParams.builder("user@example.com")
                .slug("welcome")
                .attachment(TransactionalAttachment.builder("report.pdf")
                        .url("https://example.com/report.pdf")
                        .build())
                .build();

        assertEquals(1, params.getAttachments().size());
    }

    @Test
    void builderRejectsTotalSizeOver10Mb() {
        // Base64 decodes to ~3/4 of its length; ~14M valid base64 chars decode
        // to >10MB, tripping the cap.
        char[] payload = new char[14 * 1024 * 1024];
        java.util.Arrays.fill(payload, 'A');
        String big = new String(payload);

        SendTransactionalParams.Builder builder = SendTransactionalParams.builder("user@example.com")
                .slug("welcome")
                .attachment(TransactionalAttachment.builder("big.bin").content(big).build());

        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class, builder::build);
        assertTrue(ex.getMessage().contains("exceeds 10MB limit"), ex.getMessage());
    }

    @Test
    void builderAcceptsTotalSizeUnder10Mb() {
        char[] payload = new char[1024 * 1024]; // ~768KB decoded
        java.util.Arrays.fill(payload, 'A');

        SendTransactionalParams params = SendTransactionalParams.builder("user@example.com")
                .slug("welcome")
                .attachment(TransactionalAttachment.builder("small.bin").content(new String(payload)).build())
                .build();

        assertEquals(1, params.getAttachments().size());
    }
}
