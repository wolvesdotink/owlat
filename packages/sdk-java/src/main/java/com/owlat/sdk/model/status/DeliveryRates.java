package com.owlat.sdk.model.status;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

/** The instance's bounce and complaint rates over a rolling window. */
public class DeliveryRates {

    private final int windowDays;
    private final long sent;
    private final RateAgainstLimit bounce;
    private final RateAgainstLimit complaint;

    @JsonCreator
    public DeliveryRates(
            @JsonProperty("windowDays") int windowDays,
            @JsonProperty("sent") long sent,
            @JsonProperty("bounce") RateAgainstLimit bounce,
            @JsonProperty("complaint") RateAgainstLimit complaint) {
        this.windowDays = windowDays;
        this.sent = sent;
        this.bounce = bounce;
        this.complaint = complaint;
    }

    /** Length of the rolling window, in days. */
    public int getWindowDays() {
        return windowDays;
    }

    /** Emails sent in the window. */
    public long getSent() {
        return sent;
    }

    public RateAgainstLimit getBounce() {
        return bounce;
    }

    public RateAgainstLimit getComplaint() {
        return complaint;
    }
}
