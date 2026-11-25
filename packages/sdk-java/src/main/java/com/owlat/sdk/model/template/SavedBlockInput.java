package com.owlat.sdk.model.template;

import java.util.List;
import java.util.Map;

/** The fields of a saved block. A write replaces all of them; a {@code null} description removes it. */
public class SavedBlockInput {

    private final String name;
    private final String description;
    private final List<Map<String, Object>> blocks;

    public SavedBlockInput(String name, String description, List<Map<String, Object>> blocks) {
        this.name = name;
        this.description = description;
        this.blocks = blocks;
    }

    public String getName() {
        return name;
    }

    public String getDescription() {
        return description;
    }

    /** The blocks exactly as the editor stores them. */
    public List<Map<String, Object>> getBlocks() {
        return blocks;
    }
}
