package com.owlat.sdk.model;

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

    public int getRemaining() {
        return remaining;
    }

    public int getReset() {
        return reset;
    }
}
