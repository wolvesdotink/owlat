package com.owlat.sdk.model.topic;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

public class AddToTopicResponse {

    private final boolean success;
    private final String contactId;
    private final String topicId;
    private final DoiStatus doiStatus;

    @JsonCreator
    public AddToTopicResponse(
            @JsonProperty("success") boolean success,
            @JsonProperty("contactId") String contactId,
            @JsonProperty("topicId") String topicId,
            @JsonProperty("doiStatus") DoiStatus doiStatus) {
        this.success = success;
        this.contactId = contactId;
        this.topicId = topicId;
        this.doiStatus = doiStatus;
    }

    public boolean isSuccess() {
        return success;
    }

    public String getContactId() {
        return contactId;
    }

    public String getTopicId() {
        return topicId;
    }

    public DoiStatus getDoiStatus() {
        return doiStatus;
    }
}
