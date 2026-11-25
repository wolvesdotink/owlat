package com.owlat.sdk.model.domain;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

/** A sending domain with its verification state and the DNS records it needs. */
public class SendingDomainSetup {

    private final String id;
    private final String domain;
    private final String status;
    private final String lastCheckedAt;
    private final List<SendingDomainRecord> records;

    @JsonCreator
    public SendingDomainSetup(
            @JsonProperty("id") String id,
            @JsonProperty("domain") String domain,
            @JsonProperty("status") String status,
            @JsonProperty("lastCheckedAt") String lastCheckedAt,
            @JsonProperty("records") List<SendingDomainRecord> records) {
        this.id = id;
        this.domain = domain;
        this.status = status;
        this.lastCheckedAt = lastCheckedAt;
        this.records = records == null ? List.of() : List.copyOf(records);
    }

    public String getId() {
        return id;
    }

    public String getDomain() {
        return domain;
    }

    /** {@code registering}, {@code pending}, {@code verified} or {@code failed}. Only {@code verified} can send. */
    public String getStatus() {
        return status;
    }

    /** ISO 8601 timestamp of the last check that reached a verdict, or {@code null} before the first. */
    public String getLastCheckedAt() {
        return lastCheckedAt;
    }

    /** Every record to publish; empty while the domain is still being registered. */
    public List<SendingDomainRecord> getRecords() {
        return records;
    }
}
