package com.owlat.sdk.model.event;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

public class SendEventResponse {

    private final String eventId;
    private final String contactId;
    private final String eventName;
    private final int triggeredAutomations;
    private final boolean contactCreated;

    @JsonCreator
    public SendEventResponse(
            @JsonProperty("eventId") String eventId,
            @JsonProperty("contactId") String contactId,
            @JsonProperty("eventName") String eventName,
            @JsonProperty("triggeredAutomations") int triggeredAutomations,
            @JsonProperty("contactCreated") boolean contactCreated) {
        this.eventId = eventId;
        this.contactId = contactId;
        this.eventName = eventName;
        this.triggeredAutomations = triggeredAutomations;
        this.contactCreated = contactCreated;
    }

    public String getEventId() {
        return eventId;
    }

    public String getContactId() {
        return contactId;
    }

    public String getEventName() {
        return eventName;
    }

    /**
     * The number of automations triggered by this event.
     */
    public int getTriggeredAutomations() {
        return triggeredAutomations;
    }

    public boolean isContactCreated() {
        return contactCreated;
    }
}
