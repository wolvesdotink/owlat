package com.owlat.sdk.internal;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;

public final class JsonMapper {

    private static final ObjectMapper INSTANCE = new ObjectMapper()
            .setSerializationInclusion(JsonInclude.Include.NON_NULL)
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false)
            // A body is one JSON document: content after it means the response
            // is not the API's, not an answer to read the start of.
            .configure(DeserializationFeature.FAIL_ON_TRAILING_TOKENS, true)
            .setPropertyNamingStrategy(PropertyNamingStrategies.LOWER_CAMEL_CASE);

    private JsonMapper() {
    }

    public static ObjectMapper instance() {
        return INSTANCE;
    }
}
