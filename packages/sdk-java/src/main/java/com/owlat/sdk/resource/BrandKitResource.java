package com.owlat.sdk.resource;

import com.fasterxml.jackson.core.type.TypeReference;
import com.owlat.sdk.internal.HttpClient;
import com.owlat.sdk.model.ApiResponse;
import com.owlat.sdk.model.brandkit.BrandKit;
import com.owlat.sdk.model.brandkit.BrandKitInput;

/**
 * Read and change the brand kit: the colours, fonts, button style and footer
 * every email starts from. Reads need the {@code brand-kit:read} scope, writes
 * {@code brand-kit:write}.
 */
public class BrandKitResource extends BaseResource {

    private static final String BASE_PATH = "/api/v1/brand-kit";

    public BrandKitResource(HttpClient httpClient) {
        super(httpClient);
    }

    /** The brand kit, as the brand kit page shows it. */
    public BrandKit get() {
        return httpClient.get(BASE_PATH, new TypeReference<ApiResponse<BrandKit>>() {}).getData();
    }

    /**
     * Change the fields {@code input} sets; a field left unset keeps its stored
     * value. Returns the whole kit as stored.
     *
     * @throws com.owlat.sdk.exception.ValidationException if a value is refused; its data names the field
     */
    public BrandKit update(BrandKitInput input) {
        return httpClient.put(BASE_PATH, input, new TypeReference<ApiResponse<BrandKit>>() {}).getData();
    }
}
