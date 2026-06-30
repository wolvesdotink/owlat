package com.owlat.sdk.model;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.owlat.sdk.internal.JsonMapper;
import com.owlat.sdk.model.contact.Contact;
import com.owlat.sdk.model.contact.DeleteContactResponse;
import com.owlat.sdk.model.event.SendEventResponse;
import com.owlat.sdk.model.topic.AddToTopicResponse;
import com.owlat.sdk.model.topic.DoiStatus;
import com.owlat.sdk.model.transactional.SendTransactionalResponse;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Regression coverage for the {@code { "data": {...} }} success envelope that
 * the API wraps every single-resource response in. The resources deserialize
 * into {@link ApiResponse}{@code <T>} and call {@code getData()}; before this
 * was wired up, deserializing the envelope straight into the model silently
 * produced an all-null object (the unknown top-level {@code data} key was
 * ignored). These tests bind the real envelope JSON and assert the fields
 * survive.
 */
class ApiResponseEnvelopeTest {

    private final ObjectMapper mapper = JsonMapper.instance();

    @Test
    void unwrapsContactFromDataEnvelope() throws Exception {
        String json = "{\"data\":{"
                + "\"id\":\"j57abc\","
                + "\"email\":\"jane@example.com\","
                + "\"firstName\":\"Jane\","
                + "\"lastName\":\"Smith\","
                + "\"source\":\"api\","
                + "\"createdAt\":\"2026-02-17T14:00:00.000Z\","
                + "\"updatedAt\":\"2026-02-17T14:05:00.000Z\""
                + "}}";

        ApiResponse<Contact> envelope =
                mapper.readValue(json, new TypeReference<ApiResponse<Contact>>() {});
        Contact contact = envelope.getData();

        assertNotNull(contact, "envelope must unwrap a non-null Contact");
        assertEquals("j57abc", contact.getId());
        assertEquals("jane@example.com", contact.getEmail());
        assertEquals("Jane", contact.getFirstName());
        assertEquals("Smith", contact.getLastName());
        assertEquals("api", contact.getSource());
        assertEquals("2026-02-17T14:00:00.000Z", contact.getCreatedAt());
        assertEquals("2026-02-17T14:05:00.000Z", contact.getUpdatedAt());
    }

    @Test
    void unwrapsDeleteResponseFromDataEnvelope() throws Exception {
        String json = "{\"data\":{\"id\":\"j57abc\",\"deleted\":true}}";

        ApiResponse<DeleteContactResponse> envelope =
                mapper.readValue(json, new TypeReference<ApiResponse<DeleteContactResponse>>() {});
        DeleteContactResponse deleted = envelope.getData();

        assertNotNull(deleted);
        assertEquals("j57abc", deleted.getId());
        assertTrue(deleted.isDeleted());
    }

    @Test
    void unwrapsSendEventResponseWithIntTriggeredAutomations() throws Exception {
        // The API returns `triggeredAutomations` as a NUMBER (a count), not a list.
        String json = "{\"data\":{"
                + "\"eventId\":\"evt_123\","
                + "\"contactId\":\"j57abc\","
                + "\"eventName\":\"purchase_completed\","
                + "\"triggeredAutomations\":3,"
                + "\"contactCreated\":true"
                + "}}";

        ApiResponse<SendEventResponse> envelope =
                mapper.readValue(json, new TypeReference<ApiResponse<SendEventResponse>>() {});
        SendEventResponse event = envelope.getData();

        assertNotNull(event);
        assertEquals("evt_123", event.getEventId());
        assertEquals("j57abc", event.getContactId());
        assertEquals("purchase_completed", event.getEventName());
        assertEquals(3, event.getTriggeredAutomations());
        assertTrue(event.isContactCreated());
    }

    @Test
    void unwrapsSendTransactionalResponseFromDataEnvelope() throws Exception {
        String json = "{\"data\":{"
                + "\"status\":\"queued\","
                + "\"email\":\"john@example.com\","
                + "\"transactionalEmailId\":\"send_abc\","
                + "\"slug\":\"order-confirmation\","
                + "\"contactId\":\"j58def\","
                + "\"contactCreated\":false,"
                + "\"language\":\"en\""
                + "}}";

        ApiResponse<SendTransactionalResponse> envelope =
                mapper.readValue(json, new TypeReference<ApiResponse<SendTransactionalResponse>>() {});
        SendTransactionalResponse result = envelope.getData();

        assertNotNull(result);
        assertEquals("queued", result.getStatus());
        assertEquals("john@example.com", result.getEmail());
        assertEquals("send_abc", result.getTransactionalEmailId());
        assertEquals("order-confirmation", result.getSlug());
        assertEquals("j58def", result.getContactId());
        assertFalse(result.isContactCreated());
        assertEquals("en", result.getLanguage());
    }

    @Test
    void unwrapsAddToTopicResponseWithDoiStatusEnum() throws Exception {
        String json = "{\"data\":{"
                + "\"success\":true,"
                + "\"contactId\":\"j57abc\","
                + "\"topicId\":\"k19xyz\","
                + "\"doiStatus\":\"pending\""
                + "}}";

        ApiResponse<AddToTopicResponse> envelope =
                mapper.readValue(json, new TypeReference<ApiResponse<AddToTopicResponse>>() {});
        AddToTopicResponse added = envelope.getData();

        assertNotNull(added);
        assertTrue(added.isSuccess());
        assertEquals("j57abc", added.getContactId());
        assertEquals("k19xyz", added.getTopicId());
        assertEquals(DoiStatus.PENDING, added.getDoiStatus());
    }
}
