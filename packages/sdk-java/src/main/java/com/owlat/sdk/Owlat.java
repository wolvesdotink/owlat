package com.owlat.sdk;

import com.owlat.sdk.internal.HttpClient;
import com.owlat.sdk.resource.ContactsResource;
import com.owlat.sdk.resource.EventsResource;
import com.owlat.sdk.resource.TopicsResource;
import com.owlat.sdk.resource.TransactionalResource;

public class Owlat {

    private final ContactsResource contacts;
    private final TransactionalResource transactional;
    private final EventsResource events;
    private final TopicsResource topics;

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
}
