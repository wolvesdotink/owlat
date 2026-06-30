package com.owlat.sdk.model.event;

import java.util.Map;

public class SendEventParams {

    private final String email;
    private final String eventName;
    private final Map<String, Object> eventProperties;
    private final Boolean createContactIfNotExists;

    private SendEventParams(Builder builder) {
        this.email = builder.email;
        this.eventName = builder.eventName;
        this.eventProperties = builder.eventProperties;
        this.createContactIfNotExists = builder.createContactIfNotExists;
    }

    public String getEmail() {
        return email;
    }

    public String getEventName() {
        return eventName;
    }

    public Map<String, Object> getEventProperties() {
        return eventProperties;
    }

    public Boolean getCreateContactIfNotExists() {
        return createContactIfNotExists;
    }

    public static Builder builder(String email, String eventName) {
        return new Builder(email, eventName);
    }

    public static class Builder {
        private final String email;
        private final String eventName;
        private Map<String, Object> eventProperties;
        private Boolean createContactIfNotExists;

        private Builder(String email, String eventName) {
            this.email = email;
            this.eventName = eventName;
        }

        public Builder eventProperties(Map<String, Object> eventProperties) {
            this.eventProperties = eventProperties;
            return this;
        }

        public Builder createContactIfNotExists(boolean createContactIfNotExists) {
            this.createContactIfNotExists = createContactIfNotExists;
            return this;
        }

        public SendEventParams build() {
            return new SendEventParams(this);
        }
    }
}
