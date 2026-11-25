package com.owlat.sdk.model.brandkit;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

/** A social link in the footer of every email. */
public class BrandKitSocialLink {

    private final String platform;
    private final String url;

    @JsonCreator
    public BrandKitSocialLink(
            @JsonProperty("platform") String platform,
            @JsonProperty("url") String url) {
        this.platform = platform;
        this.url = url;
    }

    /** A platform such as {@code github}, {@code linkedin} or {@code bluesky}. */
    public String getPlatform() {
        return platform;
    }

    /** An absolute http(s) URL. */
    public String getUrl() {
        return url;
    }
}
