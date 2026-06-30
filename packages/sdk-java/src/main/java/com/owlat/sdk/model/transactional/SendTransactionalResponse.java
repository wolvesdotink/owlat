package com.owlat.sdk.model.transactional;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

public class SendTransactionalResponse {

    private final String status;
    private final String email;
    private final String transactionalEmailId;
    private final String slug;
    private final String contactId;
    private final boolean contactCreated;
    private final String language;

    @JsonCreator
    public SendTransactionalResponse(
            @JsonProperty("status") String status,
            @JsonProperty("email") String email,
            @JsonProperty("transactionalEmailId") String transactionalEmailId,
            @JsonProperty("slug") String slug,
            @JsonProperty("contactId") String contactId,
            @JsonProperty("contactCreated") boolean contactCreated,
            @JsonProperty("language") String language) {
        this.status = status;
        this.email = email;
        this.transactionalEmailId = transactionalEmailId;
        this.slug = slug;
        this.contactId = contactId;
        this.contactCreated = contactCreated;
        this.language = language;
    }

    public String getStatus() {
        return status;
    }

    public String getEmail() {
        return email;
    }

    /**
     * The id of the send record created for this email (a {@code transactionalSends}
     * row), NOT the template id. Use it to correlate with delivery webhooks.
     */
    public String getTransactionalEmailId() {
        return transactionalEmailId;
    }

    public String getSlug() {
        return slug;
    }

    public String getContactId() {
        return contactId;
    }

    public boolean isContactCreated() {
        return contactCreated;
    }

    public String getLanguage() {
        return language;
    }
}
