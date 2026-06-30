package com.owlat.sdk.resource;

import com.owlat.sdk.internal.HttpClient;

public abstract class BaseResource {

    protected final HttpClient httpClient;

    protected BaseResource(HttpClient httpClient) {
        this.httpClient = httpClient;
    }
}
