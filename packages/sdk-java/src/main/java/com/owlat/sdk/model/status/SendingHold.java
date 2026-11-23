package com.owlat.sdk.model.status;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Sending is suspended or banned, so every new send is refused. The same
 * fields the {@code 403 abuse_blocked} refusal of a transactional send carries.
 */
public class SendingHold {

    private final String status;
    private final String since;
    private final String detail;
    private final SendingHoldLift lift;

    @JsonCreator
    public SendingHold(
            @JsonProperty("status") String status,
            @JsonProperty("since") String since,
            @JsonProperty("detail") String detail,
            @JsonProperty("lift") SendingHoldLift lift) {
        this.status = status;
        this.since = since;
        this.detail = detail;
        this.lift = lift;
    }

    /** {@code suspended} or {@code banned}. */
    public String getStatus() {
        return status;
    }

    /** ISO 8601 timestamp of when the status was set, or {@code null} if it was not recorded. */
    public String getSince() {
        return since;
    }

    /** The reason recorded with the status, or {@code null} when none was. */
    public String getDetail() {
        return detail;
    }

    /** How it lifts. */
    public SendingHoldLift getLift() {
        return lift;
    }
}
