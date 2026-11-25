package com.owlat.sdk.model.template;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;

/** Health scores from 0 to 100, higher is better. */
public class EmailHealth {

    private final int overall;
    private final int compatibility;
    private final int accessibility;
    private final int deliverability;
    private final int outlookSupport;
    private final List<EmailHealthRecommendation> recommendations;
    private final EmailHtmlAnalysis analysis;

    @JsonCreator
    public EmailHealth(
            @JsonProperty("overall") int overall,
            @JsonProperty("compatibility") int compatibility,
            @JsonProperty("accessibility") int accessibility,
            @JsonProperty("deliverability") int deliverability,
            @JsonProperty("outlookSupport") int outlookSupport,
            @JsonProperty("recommendations") List<EmailHealthRecommendation> recommendations,
            @JsonProperty("analysis") EmailHtmlAnalysis analysis) {
        this.overall = overall;
        this.compatibility = compatibility;
        this.accessibility = accessibility;
        this.deliverability = deliverability;
        this.outlookSupport = outlookSupport;
        this.recommendations = recommendations;
        this.analysis = analysis;
    }

    /** Weighted: compatibility 35%, deliverability 30%, accessibility 20%, Outlook 15%. */
    public int getOverall() {
        return overall;
    }

    /** Support of the top-level blocks across the known mail clients, per block. */
    public int getCompatibility() {
        return compatibility;
    }

    /** 100 less 20 per accessibility error and 10 per warning. */
    public int getAccessibility() {
        return accessibility;
    }

    /** 100 less deductions for size, missing text, images, hidden elements, links and CSS size. */
    public int getDeliverability() {
        return deliverability;
    }

    /** Support of the top-level blocks in the Outlook clients. */
    public int getOutlookSupport() {
        return outlookSupport;
    }

    public List<EmailHealthRecommendation> getRecommendations() {
        return recommendations;
    }

    public EmailHtmlAnalysis getAnalysis() {
        return analysis;
    }
}
