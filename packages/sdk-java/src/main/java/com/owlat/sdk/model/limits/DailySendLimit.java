package com.owlat.sdk.model.limits;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

/** The cap on sends per API key and UTC day, and the asking key's count. */
public class DailySendLimit {

    private final boolean isEnabled;
    private final int limit;
    private final Integer used;
    private final Integer remaining;
    private final String resetsAt;

    @JsonCreator
    public DailySendLimit(
            @JsonProperty("isEnabled") boolean isEnabled,
            @JsonProperty("limit") int limit,
            @JsonProperty("used") Integer used,
            @JsonProperty("remaining") Integer remaining,
            @JsonProperty("resetsAt") String resetsAt) {
        this.isEnabled = isEnabled;
        this.limit = limit;
        this.used = used;
        this.remaining = remaining;
        this.resetsAt = resetsAt;
    }

    /** Whether the instance admin has the cap on. */
    public boolean isEnabled() {
        return isEnabled;
    }

    /** Sends allowed per key and UTC day; kept while the cap is off. */
    public int getLimit() {
        return limit;
    }

    /** Sends counted against this key today; {@code null} while the cap is off. */
    public Integer getUsed() {
        return used;
    }

    /** Sends this key may still make today, never below 0; {@code null} while the cap is off. */
    public Integer getRemaining() {
        return remaining;
    }

    /** ISO 8601 time the count starts again (the next UTC midnight); {@code null} while the cap is off. */
    public String getResetsAt() {
        return resetsAt;
    }
}
