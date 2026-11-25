package com.owlat.sdk.model.brandkit;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

/** A logo file of the brand kit, from the media library. */
public class BrandKitLogo {

    private final String url;
    private final Double width;

    @JsonCreator
    public BrandKitLogo(
            @JsonProperty("url") String url,
            @JsonProperty("width") Double width) {
        this.url = url;
        this.width = width;
    }

    public String getUrl() {
        return url;
    }

    /** Width in pixels, or {@code null} when the file does not say. */
    public Double getWidth() {
        return width;
    }
}
