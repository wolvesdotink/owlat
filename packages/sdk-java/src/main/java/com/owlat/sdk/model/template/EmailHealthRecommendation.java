package com.owlat.sdk.model.template;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

/** One reason a health score is lower than it could be. */
public class EmailHealthRecommendation {

    private final String category;
    private final String message;
    private final String impact;

    @JsonCreator
    public EmailHealthRecommendation(
            @JsonProperty("category") String category,
            @JsonProperty("message") String message,
            @JsonProperty("impact") String impact) {
        this.category = category;
        this.message = message;
        this.impact = impact;
    }

    /** {@code compatibility}, {@code accessibility}, {@code deliverability} or {@code outlook}. */
    public String getCategory() {
        return category;
    }

    public String getMessage() {
        return message;
    }

    /** {@code high}, {@code medium} or {@code low}. */
    public String getImpact() {
        return impact;
    }
}
