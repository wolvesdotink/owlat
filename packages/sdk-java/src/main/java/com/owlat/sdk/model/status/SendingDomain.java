package com.owlat.sdk.model.status;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

/** One sending domain and where its verification stands. */
public class SendingDomain {

    private final String domain;
    private final String status;

    @JsonCreator
    public SendingDomain(@JsonProperty("domain") String domain, @JsonProperty("status") String status) {
        this.domain = domain;
        this.status = status;
    }

    public String getDomain() {
        return domain;
    }

    /** {@code registering}, {@code pending}, {@code verified} or {@code failed}. Only {@code verified} can send. */
    public String getStatus() {
        return status;
    }
}
