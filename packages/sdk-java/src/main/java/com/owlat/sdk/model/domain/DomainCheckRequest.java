package com.owlat.sdk.model.domain;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * A queued check of one sending domain, as {@code domains().verify(domain)}
 * answers it. Read the result from {@code domains().list()} once the domain's
 * {@code lastCheckedAt} is at or after {@link #getRequestedAt()}.
 */
public class DomainCheckRequest {

    private final String id;
    private final String domain;
    private final String status;
    private final String lastCheckedAt;
    private final String requestedAt;

    @JsonCreator
    public DomainCheckRequest(
            @JsonProperty("id") String id,
            @JsonProperty("domain") String domain,
            @JsonProperty("status") String status,
            @JsonProperty("lastCheckedAt") String lastCheckedAt,
            @JsonProperty("requestedAt") String requestedAt) {
        this.id = id;
        this.domain = domain;
        this.status = status;
        this.lastCheckedAt = lastCheckedAt;
        this.requestedAt = requestedAt;
    }

    public String getId() {
        return id;
    }

    public String getDomain() {
        return domain;
    }

    /** Verification state before the check. */
    public String getStatus() {
        return status;
    }

    /** ISO 8601 timestamp of the last check that reached a verdict, or {@code null} before the first. */
    public String getLastCheckedAt() {
        return lastCheckedAt;
    }

    /** ISO 8601 timestamp the check was requested. */
    public String getRequestedAt() {
        return requestedAt;
    }
}
