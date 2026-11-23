package com.owlat.sdk.model.status;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

/** What has to be true for a suspension to lift by itself, and where it stands. */
public class SendingHoldLiftCondition {

    private final String trigger;
    private final String domain;
    private final Double currentPct;
    private final double limitPct;
    private final boolean isClear;
    private final String clearsAt;

    @JsonCreator
    public SendingHoldLiftCondition(
            @JsonProperty("trigger") String trigger,
            @JsonProperty("domain") String domain,
            @JsonProperty("currentPct") Double currentPct,
            @JsonProperty("limitPct") double limitPct,
            @JsonProperty("isClear") boolean isClear,
            @JsonProperty("clearsAt") String clearsAt) {
        this.trigger = trigger;
        this.domain = domain;
        this.currentPct = currentPct;
        this.limitPct = limitPct;
        this.isClear = isClear;
        this.clearsAt = clearsAt;
    }

    /** {@code bounce_rate}, {@code complaint_rate} or {@code gmail_spam_rate}. */
    public String getTrigger() {
        return trigger;
    }

    /** The sending domain of a Gmail spam rate; {@code null} for the instance-wide rates. */
    public String getDomain() {
        return domain;
    }

    /** The metric now, in percent; {@code null} when no evidence is left in the window. */
    public Double getCurrentPct() {
        return currentPct;
    }

    /** Sending resumes once the metric is under this, in percent. */
    public double getLimitPct() {
        return limitPct;
    }

    /** The metric is back under the limit: sending resumes at the next hourly check. */
    @JsonProperty("isClear")
    public boolean isClear() {
        return isClear;
    }

    /** ISO 8601 time the last Gmail reading over the limit leaves the 30-day window, or {@code null}. */
    public String getClearsAt() {
        return clearsAt;
    }
}
