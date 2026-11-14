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
     * The id of the send created for this email, NOT the template id. Every
     * {@code email.*} webhook for this send carries it as {@code sendId}, and
     * {@link com.owlat.sdk.resource.TransactionalResource#get(String)} reads its status.
     */
    public String getTransactionalEmailId() {
        return transactionalEmailId;
    }

    /** Slug of the template used, also when the request named the template by id. */
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
