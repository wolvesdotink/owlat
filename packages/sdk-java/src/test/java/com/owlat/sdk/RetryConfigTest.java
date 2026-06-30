package com.owlat.sdk;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class RetryConfigTest {

    @Test
    void defaultsMatchTheJsSdkDefaults() {
        RetryConfig retry = RetryConfig.defaults();
        assertEquals(2, retry.getMaxRetries());
        assertEquals(500L, retry.getInitialDelayMs());
        assertEquals(2, retry.getBackoffMultiplier());
    }

    @Test
    void disabledMakesExactlyOneAttempt() {
        assertEquals(0, RetryConfig.disabled().getMaxRetries());
    }

    @Test
    void builderTunesEachField() {
        RetryConfig retry = RetryConfig.builder()
                .maxRetries(5)
                .initialDelayMs(100)
                .backoffMultiplier(3)
                .build();
        assertEquals(5, retry.getMaxRetries());
        assertEquals(100L, retry.getInitialDelayMs());
        assertEquals(3, retry.getBackoffMultiplier());
    }

    @Test
    void builderRejectsNegativeMaxRetries() {
        assertThrows(IllegalArgumentException.class, () -> RetryConfig.builder().maxRetries(-1));
    }

    @Test
    void builderRejectsNegativeInitialDelay() {
        assertThrows(IllegalArgumentException.class, () -> RetryConfig.builder().initialDelayMs(-1));
    }

    @Test
    void builderRejectsBackoffMultiplierBelowOne() {
        assertThrows(IllegalArgumentException.class, () -> RetryConfig.builder().backoffMultiplier(0));
    }

    @Test
    void configDefaultsToTheDefaultRetryConfig() {
        OwlatConfig config = OwlatConfig.builder("sk_test").build();
        assertNotNull(config.getRetry());
        assertEquals(2, config.getRetry().getMaxRetries());
    }

    @Test
    void configHonorsACustomRetryConfig() {
        OwlatConfig config = OwlatConfig.builder("sk_test")
                .retry(RetryConfig.disabled())
                .build();
        assertEquals(0, config.getRetry().getMaxRetries());
    }

    @Test
    void configRejectsNullRetry() {
        assertThrows(IllegalArgumentException.class,
                () -> OwlatConfig.builder("sk_test").retry(null));
    }
}
