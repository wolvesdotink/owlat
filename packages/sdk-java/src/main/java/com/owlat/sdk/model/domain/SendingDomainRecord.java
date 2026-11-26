package com.owlat.sdk.model.domain;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

/** One DNS record a sending domain needs published, and what the last check found. */
public class SendingDomainRecord {

    private final String purpose;
    private final String type;
    private final String host;
    private final String value;
    private final Integer priority;
    private final String state;
    private final String foundValue;
    private final boolean optional;

    @JsonCreator
    public SendingDomainRecord(
            @JsonProperty("purpose") String purpose,
            @JsonProperty("type") String type,
            @JsonProperty("host") String host,
            @JsonProperty("value") String value,
            @JsonProperty("priority") Integer priority,
            @JsonProperty("state") String state,
            @JsonProperty("foundValue") String foundValue,
            @JsonProperty("optional") Boolean optional) {
        this.purpose = purpose;
        this.type = type;
        this.host = host;
        this.value = value;
        this.priority = priority;
        this.state = state;
        this.foundValue = foundValue;
        this.optional = Boolean.TRUE.equals(optional);
    }

    /** {@code spf}, {@code dkim}, {@code dmarc} or {@code mail_from} (the return-path host). */
    public String getPurpose() {
        return purpose;
    }

    /** {@code TXT}, {@code CNAME} or {@code MX}. */
    public String getType() {
        return type;
    }

    /** The record's full name, where it is published and looked up. */
    public String getHost() {
        return host;
    }

    /** The value to publish. */
    public String getValue() {
        return value;
    }

    /** The MX priority, or {@code null} for every other type. */
    public Integer getPriority() {
        return priority;
    }

    /**
     * What the last check found: {@code found} with the expected value,
     * {@code wrong} (another value), {@code missing}, or {@code unchecked} (no
     * check yet, or DNS gave no answer).
     */
    public String getState() {
        return state;
    }

    /** The value the last check found instead, while the state is {@code wrong}; otherwise {@code null}. */
    public String getFoundValue() {
        return foundValue;
    }

    /**
     * {@code true} for a record the domain does not need, whose state never
     * decides whether the domain is verified: the optional second DKIM key
     * (Ed25519). {@code false} for every other record.
     */
    @JsonProperty("optional")
    public boolean isOptional() {
        return optional;
    }
}
