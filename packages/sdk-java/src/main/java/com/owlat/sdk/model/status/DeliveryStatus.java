package com.owlat.sdk.model.status;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

/**
 * Whether the instance can send, as {@code GET /api/v1/status} answers it: the
 * worst problem with its fix, each sending domain, the rolling bounce and
 * complaint rates and a suspension or ban in force.
 */
public class DeliveryStatus {

    private final String level;
    private final String reasonCode;
    private final String explanation;
    private final DeliveryFix fix;
    private final List<SendingDomain> domains;
    private final DeliveryRates rates;
    private final SendingHold sendingHold;

    @JsonCreator
    public DeliveryStatus(
            @JsonProperty("level") String level,
            @JsonProperty("reasonCode") String reasonCode,
            @JsonProperty("explanation") String explanation,
            @JsonProperty("fix") DeliveryFix fix,
            @JsonProperty("domains") List<SendingDomain> domains,
            @JsonProperty("rates") DeliveryRates rates,
            @JsonProperty("sendingHold") SendingHold sendingHold) {
        this.level = level;
        this.reasonCode = reasonCode;
        this.explanation = explanation;
        this.fix = fix;
        this.domains = domains == null ? List.of() : List.copyOf(domains);
        this.rates = rates;
        this.sendingHold = sendingHold;
    }

    /**
     * {@code ok}, {@code warn} (needs attention) or {@code error} (a serious problem
     * that affects or threatens delivery). Whether sending is suspended now is
     * {@link #getSendingHold()}.
     */
    public String getLevel() {
        return level;
    }

    /**
     * The worst problem as a stable code, for example {@code healthy},
     * {@code domain_failed} or {@code sending_suspended}. New codes can be
     * added; treat an unknown one by its {@link #getLevel() level}.
     */
    public String getReasonCode() {
        return reasonCode;
    }

    /** What the reason means and what to do about it, in English. */
    public String getExplanation() {
        return explanation;
    }

    /** Where the fix is made, or {@code null} when there is nothing to fix. */
    public DeliveryFix getFix() {
        return fix;
    }

    /** Every sending domain with its verification state. */
    public List<SendingDomain> getDomains() {
        return domains;
    }

    /** The 30-day rates, or {@code null} while the window holds no sends, deliveries, bounces or complaints. */
    public DeliveryRates getRates() {
        return rates;
    }

    /** The suspension or ban in force, or {@code null} while sending is allowed. */
    public SendingHold getSendingHold() {
        return sendingHold;
    }
}
