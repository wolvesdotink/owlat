package com.owlat.sdk;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * No self-hosted instance answers at the default base URL, so a config left on
 * it sends the API key to a host its owner did not choose. Building one warns.
 */
class OwlatConfigDefaultBaseUrlTest {

    private final Logger logger = Logger.getLogger("com.owlat.sdk");
    private final List<LogRecord> records = new ArrayList<>();
    private final Handler capture = new Handler() {
        @Override
        public void publish(LogRecord record) {
            records.add(record);
        }

        @Override
        public void flush() {
        }

        @Override
        public void close() {
        }
    };

    @BeforeEach
    void attach() {
        logger.addHandler(capture);
    }

    @AfterEach
    void detach() {
        logger.removeHandler(capture);
    }

    @Test
    void warnsWhenNoBaseUrlIsGiven() {
        OwlatConfig config = OwlatConfig.builder("lm_live_test123").build();

        assertEquals("https://api.owlat.app", config.getBaseUrl());
        assertEquals(1, records.size());
        LogRecord record = records.get(0);
        assertEquals(Level.WARNING, record.getLevel());
        assertTrue(record.getMessage().contains("baseUrl"), record.getMessage());
        assertTrue(record.getMessage().contains("https://api.owlat.app"), record.getMessage());
        assertFalse(record.getMessage().contains("lm_live_test123"), record.getMessage());
    }

    @Test
    void anExplicitNullBaseUrlDoesNotFallBackToTheHostedAddress() {
        OwlatConfig config = OwlatConfig.builder("lm_live_test123").baseUrl(null).build();

        assertNull(config.getBaseUrl());
        assertTrue(records.isEmpty());
    }

    @Test
    void staysQuietWhenBaseUrlNamesTheInstance() {
        OwlatConfig.builder("lm_live_test123").baseUrl("https://owlat.example.com").build();

        assertTrue(records.isEmpty());
    }
}
