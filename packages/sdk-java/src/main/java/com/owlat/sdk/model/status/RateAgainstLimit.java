package com.owlat.sdk.model.status;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

/** A rate over the window, against the limit past which it counts against sending. */
public class RateAgainstLimit {

    private final double ratePct;
    private final double limitPct;
    private final boolean isOver;

    @JsonCreator
    public RateAgainstLimit(
            @JsonProperty("ratePct") double ratePct,
            @JsonProperty("limitPct") double limitPct,
            @JsonProperty("isOver") boolean isOver) {
        this.ratePct = ratePct;
        this.limitPct = limitPct;
        this.isOver = isOver;
    }

    /** The rate in percent, to three decimals. */
    public double getRatePct() {
        return ratePct;
    }

    /** The limit in percent. */
    public double getLimitPct() {
        return limitPct;
    }

    /** Whether the rate has reached the limit. */
    @JsonProperty("isOver")
    public boolean isOver() {
        return isOver;
    }
}
