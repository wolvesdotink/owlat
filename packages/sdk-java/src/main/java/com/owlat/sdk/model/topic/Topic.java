package com.owlat.sdk.model.topic;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

/** A topic contacts can be subscribed to, as {@code GET /api/v1/topics} lists it. */
public class Topic {

    private final String id;
    private final String name;
    private final String description;
    private final boolean requiresDoubleOptIn;
    private final String createdAt;

    @JsonCreator
    public Topic(
            @JsonProperty("id") String id,
            @JsonProperty("name") String name,
            @JsonProperty("description") String description,
            @JsonProperty("requiresDoubleOptIn") boolean requiresDoubleOptIn,
            @JsonProperty("createdAt") String createdAt) {
        this.id = id;
        this.name = name;
        this.description = description;
        this.requiresDoubleOptIn = requiresDoubleOptIn;
        this.createdAt = createdAt;
    }

    /** The topic ID that {@code addContact} and {@code removeContact} take. */
    public String getId() {
        return id;
    }

    public String getName() {
        return name;
    }

    /** What the topic is about, or {@code null} when it has no description. */
    public String getDescription() {
        return description;
    }

    /**
     * Whether the topic requires double opt-in: a contact whose subscription
     * is pending double opt-in counts as subscribed once they confirm their
     * address. The add call's {@code doiStatus} reports the contact's
     * confirmation state.
     */
    @JsonProperty("requiresDoubleOptIn")
    public boolean requiresDoubleOptIn() {
        return requiresDoubleOptIn;
    }

    /** ISO 8601 timestamp of when the topic was created. */
    public String getCreatedAt() {
        return createdAt;
    }
}
