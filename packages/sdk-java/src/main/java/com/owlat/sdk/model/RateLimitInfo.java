package com.owlat.sdk.model;

/**
 * The rate-limit headers of a response. Only {@link #getLimit()} describes the
 * limit: the server sends {@code X-RateLimit-Remaining} and
 * {@code X-RateLimit-Reset} as fixed values, so back off by
 * {@code RateLimitException.getRetryAfter()} instead.
 */
public class RateLimitInfo {

    private final int limit;
    private final int remaining;
    private final int reset;

    public RateLimitInfo(int limit, int remaining, int reset) {
        this.limit = limit;
        this.remaining = remaining;
        this.reset = reset;
    }

    public int getLimit() {
        return limit;
    }

    /** {@code X-RateLimit-Remaining}: 0 on a 429 from the per-key limit, otherwise one less than the limit. */
    public int getRemaining() {
        return remaining;
    }

    /** {@code X-RateLimit-Reset}: a Unix timestamp one second after the response. */
    public int getReset() {
        return reset;
    }
}
