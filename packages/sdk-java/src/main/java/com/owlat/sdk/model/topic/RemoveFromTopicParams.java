package com.owlat.sdk.model.topic;

public class RemoveFromTopicParams {

    private final String topicId;
    private final String emailOrId;

    public RemoveFromTopicParams(String topicId, String emailOrId) {
        this.topicId = topicId;
        this.emailOrId = emailOrId;
    }

    public String getTopicId() {
        return topicId;
    }

    public String getEmailOrId() {
        return emailOrId;
    }
}
