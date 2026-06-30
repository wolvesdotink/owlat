package com.owlat.sdk.model.topic;

import com.fasterxml.jackson.annotation.JsonIgnore;

public class AddToTopicParams {

    @JsonIgnore
    private final String topicId;
    private final String email;
    private final String contactId;

    private AddToTopicParams(Builder builder) {
        this.topicId = builder.topicId;
        this.email = builder.email;
        this.contactId = builder.contactId;
    }

    public String getTopicId() {
        return topicId;
    }

    public String getEmail() {
        return email;
    }

    public String getContactId() {
        return contactId;
    }

    public static Builder builder(String topicId) {
        return new Builder(topicId);
    }

    public static class Builder {
        private final String topicId;
        private String email;
        private String contactId;

        private Builder(String topicId) {
            this.topicId = topicId;
        }

        public Builder email(String email) {
            this.email = email;
            return this;
        }

        public Builder contactId(String contactId) {
            this.contactId = contactId;
            return this;
        }

        public AddToTopicParams build() {
            if (email == null && contactId == null) {
                throw new IllegalArgumentException("Either email or contactId must be provided");
            }
            return new AddToTopicParams(this);
        }
    }
}
