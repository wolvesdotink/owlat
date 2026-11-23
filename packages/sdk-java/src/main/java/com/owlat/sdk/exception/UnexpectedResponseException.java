package com.owlat.sdk.exception;

import com.owlat.sdk.model.RateLimitInfo;

/**
 * Thrown when a response is not the Owlat API's: an error status whose body is
 * not the {@code {"error": {"category", "message"}}} envelope, or a 2xx body
 * that is not JSON. The usual cause is a base URL that points somewhere other
 * than the instance's API (the web app's address, a typo, a missing path
 * prefix), or a proxy in front of the instance answering for it. The URL
 * leaves out the query string and any credentials; neither field ever holds
 * the API key.
 */
public class UnexpectedResponseException extends OwlatException {

    private final String url;
    private final String bodyExcerpt;

    public UnexpectedResponseException(int statusCode, String url, String bodyExcerpt, RateLimitInfo rateLimit) {
        super("Unexpected response from " + url + " (HTTP " + statusCode + "). This does not look like an Owlat API:"
                        + " check that baseUrl is your instance's API URL."
                        + (bodyExcerpt.isEmpty() ? "" : " Body: " + bodyExcerpt),
                "unexpected_response", statusCode, rateLimit);
        this.url = url;
        this.bodyExcerpt = bodyExcerpt;
    }

    /** The URL that was called, without its query string. */
    public String getUrl() {
        return url;
    }

    /** The start of the response body, whitespace collapsed. */
    public String getBodyExcerpt() {
        return bodyExcerpt;
    }
}
