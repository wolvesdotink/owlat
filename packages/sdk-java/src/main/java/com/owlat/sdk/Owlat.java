package com.owlat.sdk;

import com.owlat.sdk.internal.HttpClient;
import com.owlat.sdk.resource.ContactsResource;
import com.owlat.sdk.resource.DomainsResource;
import com.owlat.sdk.resource.EventsResource;
import com.owlat.sdk.resource.StatusResource;
import com.owlat.sdk.resource.TopicsResource;
import com.owlat.sdk.resource.TransactionalResource;

public class Owlat {

    private final ContactsResource contacts;
    private final TransactionalResource transactional;
    private final EventsResource events;
    private final TopicsResource topics;
    private final StatusResource status;
    private final DomainsResource domains;

    /**
     * A client from an API key alone, which talks to the hosted address
     * {@code https://api.owlat.app} instead of your instance.
     *
     * @deprecated Build an {@link OwlatConfig} with
     *     {@link OwlatConfig.Builder#baseUrl(String)} set to your instance's API
     *     URL. This constructor goes away when the base URL becomes required.
     */
    @Deprecated
    public Owlat(String apiKey) {
        this(OwlatConfig.builder(apiKey).build());
    }

    public Owlat(OwlatConfig config) {
        HttpClient httpClient = new HttpClient(
                config.getApiKey(), config.getBaseUrl(), config.getTimeout(), config.getRetry());
        this.contacts = new ContactsResource(httpClient);
        this.transactional = new TransactionalResource(httpClient);
        this.events = new EventsResource(httpClient);
        this.topics = new TopicsResource(httpClient);
        this.status = new StatusResource(httpClient);
        this.domains = new DomainsResource(httpClient);
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
}
