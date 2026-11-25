package com.owlat.sdk;

import com.owlat.sdk.exception.OwlatException;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * No self-hosted instance answers at a default address, so a client without
 * its instance's API URL, or with one that can never be requested, is refused
 * when the config is built, with a message that says where to find the URL.
 */
class OwlatConfigBaseUrlTest {

    private static final String WHERE_TO_FIND_IT = "Settings → API → API quickstart";

    private static IllegalArgumentException refused(OwlatConfig.Builder builder) {
        return assertThrows(IllegalArgumentException.class, builder::build);
    }

    @Test
    void isRequiredAndTheErrorSaysWhereToFindIt() {
        IllegalArgumentException ex = refused(OwlatConfig.builder("lm_live_test123"));

        assertTrue(ex.getMessage().startsWith("baseUrl is required"), ex.getMessage());
        assertTrue(ex.getMessage().contains(WHERE_TO_FIND_IT), ex.getMessage());
        assertTrue(ex.getMessage().contains("NUXT_PUBLIC_CONVEX_SITE_URL"), ex.getMessage());
        assertFalse(ex.getMessage().contains("lm_live_test123"), ex.getMessage());
    }

    @Test
    void anExplicitNullIsMissing() {
        IllegalArgumentException ex = refused(OwlatConfig.builder("lm_live_test123").baseUrl(null));

        assertTrue(ex.getMessage().startsWith("baseUrl is required"), ex.getMessage());
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "   ", " \n"})
    void aBlankValueIsMissing(String baseUrl) {
        IllegalArgumentException ex = refused(OwlatConfig.builder("lm_live_test123").baseUrl(baseUrl));

        assertTrue(ex.getMessage().startsWith("baseUrl is required"), ex.getMessage());
    }

    @ParameterizedTest
    @ValueSource(strings = {
            "rest.api.example.com",
            "/api",
            "ftp://rest.api.example.com",
            "https://",
            "http://localhost:65536",
            "https:rest.api.example.com",
            " https://rest.api.example.com\n",
            "https://rest.api.example.com?tenant=a",
            "https://rest.api.example.com#api",
            "https://user:secret@rest.api.example.com",
    })
    void aValueThatCanNeverBeRequestedIsRefused(String baseUrl) {
        IllegalArgumentException ex = refused(OwlatConfig.builder("lm_live_test123").baseUrl(baseUrl));

        assertTrue(ex.getMessage().startsWith("baseUrl "), ex.getMessage());
        assertTrue(ex.getMessage().contains(WHERE_TO_FIND_IT), ex.getMessage());
        // The value can be a key pasted into the wrong field.
        assertFalse(ex.getMessage().contains("secret"), ex.getMessage());
    }

    @ParameterizedTest
    @CsvSource({
            "https://rest.api.example.com, https://rest.api.example.com",
            "HTTPS://rest.api.example.com, HTTPS://rest.api.example.com",
            "http://localhost:3211, http://localhost:3211",
            "http://localhost:65535, http://localhost:65535",
            "https://rest.api.example.com/, https://rest.api.example.com",
            "https://example.com/owlat, https://example.com/owlat",
            "https://example.com/owlat//, https://example.com/owlat",
    })
    void keepsAPathPrefixAndDropsATrailingSlash(String given, String expected) {
        OwlatConfig config = OwlatConfig.builder("lm_live_test123").baseUrl(given).build();

        assertEquals(expected, config.getBaseUrl());
    }

    @Test
    void requestsGoUnderThePathPrefix() throws IOException {
        AtomicReference<String> path = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            path.set(exchange.getRequestURI().getPath());
            exchange.sendResponseHeaders(404, -1);
            exchange.close();
        });
        server.start();
        try {
            Owlat owlat = new Owlat(OwlatConfig.builder("lm_live_test123")
                    .baseUrl("http://127.0.0.1:" + server.getAddress().getPort() + "/owlat/")
                    .retry(RetryConfig.disabled())
                    .build());

            assertThrows(OwlatException.class, () -> owlat.limits().get());

            assertEquals("/owlat/api/v1/limits", path.get());
        } finally {
            server.stop(0);
        }
    }
}
