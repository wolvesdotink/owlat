package com.owlat.sdk.model.limits;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * What one template sent to one address under the per-recipient cap. Given
 * only when {@code limits().get(GetLimitsParams)} names both.
 */
public class RecipientSendUsage {

    private final String email;
    private final String templateId;
    private final String slug;
    private final boolean isExempt;
    private final Integer used;
    private final Integer remaining;
    private final String resetsAt;

    @JsonCreator
    public RecipientSendUsage(
            @JsonProperty("email") String email,
            @JsonProperty("templateId") String templateId,
            @JsonProperty("slug") String slug,
            @JsonProperty("isExempt") boolean isExempt,
            @JsonProperty("used") Integer used,
            @JsonProperty("remaining") Integer remaining,
            @JsonProperty("resetsAt") String resetsAt) {
        this.email = email;
        this.templateId = templateId;
        this.slug = slug;
        this.isExempt = isExempt;
        this.used = used;
        this.remaining = remaining;
        this.resetsAt = resetsAt;
    }

    /** The address, trimmed and lowercased as the send route stores it. */
    public String getEmail() {
        return email;
    }

    /** ID of the template. */
    public String getTemplateId() {
        return templateId;
    }

    /** Slug of the template. */
    public String getSlug() {
        return slug;
    }

    /** Whether the template is exempt from the cap; then nothing is counted. */
    public boolean isExempt() {
        return isExempt;
    }

    /** Sends counted against the pair now, rounded up; {@code null} while the cap is off or the template is exempt. */
    public Integer getUsed() {
        return used;
    }

    /** Sends of the template to the address that fit now, never below 0; {@code null} while the cap is off or the template is exempt. */
    public Integer getRemaining() {
        return remaining;
    }

    /** ISO 8601 time the count is back to zero; {@code null} when nothing is counted. */
    public String getResetsAt() {
        return resetsAt;
    }
}
