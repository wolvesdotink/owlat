package com.owlat.sdk.model.status;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

/** How a suspension lifts, and on what condition when it lifts by itself. */
public class SendingHoldLift {

    private final String mode;
    private final SendingHoldLiftCondition condition;

    @JsonCreator
    public SendingHoldLift(
            @JsonProperty("mode") String mode,
            @JsonProperty("condition") SendingHoldLiftCondition condition) {
        this.mode = mode;
        this.condition = condition;
    }

    /**
     * {@code automatic}: lifts by itself once {@link #getCondition()} is met.
     * {@code manual_setting}: the instance waits for a platform admin, even after
     * the rates recover. {@code admin}: never lifts by itself (a ban, or a
     * suspension a platform admin imposed). A platform admin can lift any of them.
     */
    public String getMode() {
        return mode;
    }

    /** Set when the mode is {@code automatic}, otherwise {@code null}. */
    public SendingHoldLiftCondition getCondition() {
        return condition;
    }
}
