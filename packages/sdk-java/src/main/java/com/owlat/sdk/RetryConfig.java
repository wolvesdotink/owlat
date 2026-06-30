package com.owlat.sdk;

/**
 * Automatic retry configuration for transient failures, with exponential
 * backoff. Mirrors the JS SDK's {@code retry} option
 * (packages/sdk-js src/types/config.ts).
 *
 * <p>A 429 is always retried (it respects {@code Retry-After}). A 5xx or
 * network/timeout failure is only retried for idempotent methods
 * (GET/PUT/DELETE) — non-idempotent {@code POST} sends
 * ({@code transactional.send}, {@code events.send}) are never replayed, since
 * the server has no idempotency key and a retry could duplicate the send.
 *
 * <p>Use {@link #disabled()} to turn retries off entirely (the equivalent of
 * the JS SDK's {@code retry: false}). The defaults
 * ({@value #DEFAULT_MAX_RETRIES} retries, {@value #DEFAULT_INITIAL_DELAY_MS}ms
 * initial backoff, {@code ×}{@value #DEFAULT_BACKOFF_MULTIPLIER} multiplier)
 * are unchanged from the values the {@code HttpClient} previously hardcoded, so
 * existing callers behave identically.
 */
public final class RetryConfig {

    /** Default maximum retries (so {@code maxRetries + 1} total attempts). */
    public static final int DEFAULT_MAX_RETRIES = 2;

    /** Default initial backoff delay, in milliseconds. */
    public static final long DEFAULT_INITIAL_DELAY_MS = 500L;

    /** Default exponential backoff multiplier. */
    public static final int DEFAULT_BACKOFF_MULTIPLIER = 2;

    private final int maxRetries;
    private final long initialDelayMs;
    private final int backoffMultiplier;

    private RetryConfig(Builder builder) {
        this.maxRetries = builder.maxRetries;
        this.initialDelayMs = builder.initialDelayMs;
        this.backoffMultiplier = builder.backoffMultiplier;
    }

    /** The default retry configuration (the values previously hardcoded). */
    public static RetryConfig defaults() {
        return builder().build();
    }

    /**
     * Retries disabled — every request makes exactly one attempt. Equivalent to
     * the JS SDK's {@code retry: false}.
     */
    public static RetryConfig disabled() {
        return builder().maxRetries(0).build();
    }

    public static Builder builder() {
        return new Builder();
    }

    /** Maximum number of retry attempts ({@code maxRetries + 1} total). */
    public int getMaxRetries() {
        return maxRetries;
    }

    /** Initial backoff delay in milliseconds. */
    public long getInitialDelayMs() {
        return initialDelayMs;
    }

    /** Exponential backoff multiplier. */
    public int getBackoffMultiplier() {
        return backoffMultiplier;
    }

    public static final class Builder {
        private int maxRetries = DEFAULT_MAX_RETRIES;
        private long initialDelayMs = DEFAULT_INITIAL_DELAY_MS;
        private int backoffMultiplier = DEFAULT_BACKOFF_MULTIPLIER;

        private Builder() {
        }

        /**
         * Maximum retry attempts (default {@value #DEFAULT_MAX_RETRIES}, meaning
         * {@code maxRetries + 1} total attempts). Set to {@code 0} to disable
         * retries.
         *
         * @throws IllegalArgumentException if negative
         */
        public Builder maxRetries(int maxRetries) {
            if (maxRetries < 0) {
                throw new IllegalArgumentException("maxRetries must be >= 0");
            }
            this.maxRetries = maxRetries;
            return this;
        }

        /**
         * Initial backoff delay in milliseconds (default
         * {@value #DEFAULT_INITIAL_DELAY_MS}).
         *
         * @throws IllegalArgumentException if negative
         */
        public Builder initialDelayMs(long initialDelayMs) {
            if (initialDelayMs < 0) {
                throw new IllegalArgumentException("initialDelayMs must be >= 0");
            }
            this.initialDelayMs = initialDelayMs;
            return this;
        }

        /**
         * Exponential backoff multiplier (default
         * {@value #DEFAULT_BACKOFF_MULTIPLIER}).
         *
         * @throws IllegalArgumentException if less than 1
         */
        public Builder backoffMultiplier(int backoffMultiplier) {
            if (backoffMultiplier < 1) {
                throw new IllegalArgumentException("backoffMultiplier must be >= 1");
            }
            this.backoffMultiplier = backoffMultiplier;
            return this;
        }

        public RetryConfig build() {
            return new RetryConfig(this);
        }
    }
}
