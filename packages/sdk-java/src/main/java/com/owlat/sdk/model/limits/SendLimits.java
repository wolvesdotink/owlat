package com.owlat.sdk.model.limits;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * The transactional send limits that apply to this key, as
 * {@code GET /api/v1/limits} answers them.
 */
public class SendLimits {

    private final DailySendLimit dailySends;
    private final RecipientSendLimit recipientSends;

    @JsonCreator
    public SendLimits(
            @JsonProperty("dailySends") DailySendLimit dailySends,
            @JsonProperty("recipientSends") RecipientSendLimit recipientSends) {
        this.dailySends = dailySends;
        this.recipientSends = recipientSends;
    }

    /** The cap per key and UTC day, with what this key has left of it. */
    public DailySendLimit getDailySends() {
        return dailySends;
    }

    /** The cap per template and address. */
    public RecipientSendLimit getRecipientSends() {
        return recipientSends;
    }
}
