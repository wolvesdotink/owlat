package com.owlat.sdk.model.limits;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * The cap on sends of one template to one address. What is left depends on
 * the template and the address, so no count is given: a send over it is
 * refused with {@code 429} and a {@code Retry-After}. The allowance refills
 * continuously, {@link #getLimit()} per window. A template can be exempt.
 */
public class RecipientSendLimit {

    private final boolean isEnabled;
    private final int limit;
    private final int windowSeconds;

    @JsonCreator
    public RecipientSendLimit(
            @JsonProperty("isEnabled") boolean isEnabled,
            @JsonProperty("limit") int limit,
            @JsonProperty("windowSeconds") int windowSeconds) {
        this.isEnabled = isEnabled;
        this.limit = limit;
        this.windowSeconds = windowSeconds;
    }

    /** Whether the instance admin has the cap on. */
    public boolean isEnabled() {
        return isEnabled;
    }

    /** Sends allowed per template and address within the window. */
    public int getLimit() {
        return limit;
    }

    /** Length of the window, in seconds. */
    public int getWindowSeconds() {
        return windowSeconds;
    }
}
