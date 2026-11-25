package com.owlat.sdk.model.limits;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * The cap on sends of one template to one address: a send over it is refused
 * with {@code 429} and a {@code Retry-After}. The allowance refills
 * continuously, {@link #getLimit()} per window. A template can be exempt.
 */
public class RecipientSendLimit {

    private final boolean isEnabled;
    private final int limit;
    private final int windowSeconds;
    private final RecipientSendUsage usage;

    public RecipientSendLimit(boolean isEnabled, int limit, int windowSeconds) {
        this(isEnabled, limit, windowSeconds, null);
    }

    @JsonCreator
    public RecipientSendLimit(
            @JsonProperty("isEnabled") boolean isEnabled,
            @JsonProperty("limit") int limit,
            @JsonProperty("windowSeconds") int windowSeconds,
            @JsonProperty("usage") RecipientSendUsage usage) {
        this.isEnabled = isEnabled;
        this.limit = limit;
        this.windowSeconds = windowSeconds;
        this.usage = usage;
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

    /**
     * The count for the template and address the request named, or {@code null}
     * when it named none.
     */
    public RecipientSendUsage getUsage() {
        return usage;
    }
}
