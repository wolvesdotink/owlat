package com.owlat.sdk;

import com.owlat.sdk.internal.HttpClient;
import com.owlat.sdk.resource.ContactsResource;
import com.owlat.sdk.resource.DomainsResource;
import com.owlat.sdk.resource.EventsResource;
import com.owlat.sdk.resource.LimitsResource;
import com.owlat.sdk.resource.RenderResource;
import com.owlat.sdk.resource.SavedBlocksResource;
import com.owlat.sdk.resource.StatusResource;
import com.owlat.sdk.resource.TopicsResource;
import com.owlat.sdk.resource.TransactionalEmailsResource;
import com.owlat.sdk.resource.TransactionalResource;

public class Owlat {

    private final ContactsResource contacts;
    private final TransactionalResource transactional;
    private final EventsResource events;
    private final TopicsResource topics;
    private final StatusResource status;
    private final DomainsResource domains;
    private final LimitsResource limits;
    private final TransactionalEmailsResource transactionalEmails;
    private final SavedBlocksResource savedBlocks;
    private final RenderResource render;

    /**
     * A client for the instance {@code config} names. The config's builder
     * refuses a missing or unusable base URL, so every client has one.
     */
    public Owlat(OwlatConfig config) {
        HttpClient httpClient = new HttpClient(
                config.getApiKey(), config.getBaseUrl(), config.getTimeout(), config.getRetry());
        this.contacts = new ContactsResource(httpClient);
        this.transactional = new TransactionalResource(httpClient);
        this.events = new EventsResource(httpClient);
        this.topics = new TopicsResource(httpClient);
        this.status = new StatusResource(httpClient);
        this.domains = new DomainsResource(httpClient);
        this.limits = new LimitsResource(httpClient);
        this.transactionalEmails = new TransactionalEmailsResource(httpClient);
        this.savedBlocks = new SavedBlocksResource(httpClient);
        this.render = new RenderResource(httpClient);
    }

    public ContactsResource contacts() {
        return contacts;
    }

    public TransactionalResource transactional() {
        return transactional;
    }

    public EventsResource events() {
        return events;
    }

    public TopicsResource topics() {
        return topics;
    }

    /** Whether the instance can send, and why not. */
    public StatusResource status() {
        return status;
    }

    /** The sending domains and the DNS records each needs. */
    public DomainsResource domains() {
        return domains;
    }

    /** The send limits that apply to this key, and what is left of them. */
    public LimitsResource limits() {
        return limits;
    }

    /** Read and write transactional emails, and publish them. */
    public TransactionalEmailsResource transactionalEmails() {
        return transactionalEmails;
    }

    /** Read and write saved blocks. */
    public SavedBlocksResource savedBlocks() {
        return savedBlocks;
    }

    /** Render block content without storing it, as this instance would. */
    public RenderResource render() {
        return render;
    }
}
