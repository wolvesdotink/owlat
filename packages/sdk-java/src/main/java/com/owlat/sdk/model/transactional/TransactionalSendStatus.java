package com.owlat.sdk.model.transactional;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Where one transactional send stands, as {@code GET /api/v1/transactional/{sendId}}
 * answers it. Timestamps are ISO 8601 strings, {@code null} until the send reaches
 * that step. The send's data variables are never part of it.
 */
public class TransactionalSendStatus {

    private final String sendId;
    private final String status;
    private final String email;
    private final String templateId;
    private final String slug;
    private final String language;
    private final String queuedAt;
    private final String sentAt;
    private final String deliveredAt;
    private final String openedAt;
    private final String clickedAt;
    private final String bouncedAt;
    private final String complainedAt;
    private final String failedAt;
    private final String bounceType;
    private final String errorCode;
    private final String errorMessage;

    @JsonCreator
    public TransactionalSendStatus(
            @JsonProperty("sendId") String sendId,
            @JsonProperty("status") String status,
            @JsonProperty("email") String email,
            @JsonProperty("templateId") String templateId,
            @JsonProperty("slug") String slug,
            @JsonProperty("language") String language,
            @JsonProperty("queuedAt") String queuedAt,
            @JsonProperty("sentAt") String sentAt,
            @JsonProperty("deliveredAt") String deliveredAt,
            @JsonProperty("openedAt") String openedAt,
            @JsonProperty("clickedAt") String clickedAt,
            @JsonProperty("bouncedAt") String bouncedAt,
            @JsonProperty("complainedAt") String complainedAt,
            @JsonProperty("failedAt") String failedAt,
            @JsonProperty("bounceType") String bounceType,
            @JsonProperty("errorCode") String errorCode,
            @JsonProperty("errorMessage") String errorMessage) {
        this.sendId = sendId;
        this.status = status;
        this.email = email;
        this.templateId = templateId;
        this.slug = slug;
        this.language = language;
        this.queuedAt = queuedAt;
        this.sentAt = sentAt;
        this.deliveredAt = deliveredAt;
        this.openedAt = openedAt;
        this.clickedAt = clickedAt;
        this.bouncedAt = bouncedAt;
        this.complainedAt = complainedAt;
        this.failedAt = failedAt;
        this.bounceType = bounceType;
        this.errorCode = errorCode;
        this.errorMessage = errorMessage;
    }

    /** The id the send call returned as {@code transactionalEmailId}; every {@code email.*} webhook for the send carries it as {@code sendId}. */
    public String getSendId() {
        return sendId;
    }

    /** Current delivery state: {@code queued}, {@code sent}, {@code failed}, {@code delivered}, {@code opened}, {@code clicked}, {@code bounced} or {@code complained}. */
    public String getStatus() {
        return status;
    }

    /** Recipient's email address. */
    public String getEmail() {
        return email;
    }

    /** Id of the template the send used, or {@code null} once the template is gone. */
    public String getTemplateId() {
        return templateId;
    }

    /** Slug of that template, or {@code null} once the template is gone. */
    public String getSlug() {
        return slug;
    }

    /** Language the send used. */
    public String getLanguage() {
        return language;
    }

    /** ISO 8601 timestamp, or {@code null} until then. */
    public String getQueuedAt() {
        return queuedAt;
    }

    /** ISO 8601 timestamp, or {@code null} until then. */
    public String getSentAt() {
        return sentAt;
    }

    /** ISO 8601 timestamp, or {@code null} until then. */
    public String getDeliveredAt() {
        return deliveredAt;
    }

    /** ISO 8601 timestamp, or {@code null} until then. */
    public String getOpenedAt() {
        return openedAt;
    }

    /** ISO 8601 timestamp, or {@code null} until then. */
    public String getClickedAt() {
        return clickedAt;
    }

    /** ISO 8601 timestamp, or {@code null} until then. */
    public String getBouncedAt() {
        return bouncedAt;
    }

    /** ISO 8601 timestamp, or {@code null} until then. */
    public String getComplainedAt() {
        return complainedAt;
    }

    /** ISO 8601 timestamp, or {@code null} until then. */
    public String getFailedAt() {
        return failedAt;
    }

    /** {@code hard} or {@code soft} once a bounce was reported, otherwise {@code null}. */
    public String getBounceType() {
        return bounceType;
    }

    /** Stable code of the failure (for example {@code MTA_UNREACHABLE}); {@code null} unless the send failed. */
    public String getErrorCode() {
        return errorCode;
    }

    /** Human-readable reason of the failure; {@code null} unless the send failed. */
    public String getErrorMessage() {
        return errorMessage;
    }
}
