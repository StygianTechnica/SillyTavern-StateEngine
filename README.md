# State Engine

A SillyTavern extension for local state tracking with reusable preset toolkits, strict typing, and automated updates.

State Engine keeps variables in SillyTavern's native variable store (chat/global), exposes them through macros like `{{getvar::name}}`, and updates them via manual actions, counters, cycling sequences, or prompted AI decisions.

## Current version

`0.5.0-dev` (local branch state)

## Key features

- Presets system: create reusable variable toolkits and bind them per chat
- Multi-preset tracker display: show multiple preset banks at once
- Strict type validation: number, string, boolean, enum, array
- Default values per variable
- Variable categories:
  - Manual
  - Counter
  - Prompted (AI-derived values)
  - Cycling (advance through an ordered list)
- Prompted increments: AI decides **when** to increment/advance
- Batched LLM updates: relevant prompted variables are grouped into one request per trigger event
- Preset-level triggers (reduces chat-time LLM noise)
- Floating tracker panel with debug toggle
- Seeded first-run example presets (5 starter packs)
- In-progress world info condition integration (state-based lore activation controls)

## Seeded starter presets

On first run (when no presets exist), State Engine seeds example presets:

1. Story Progression
2. Location and Time
3. Relationships
4. Combat and Encounter
5. Mixed Showcase (demonstrates extra type/category combinations)

These are editable and removable, and intended as road-test baselines.

## Install

1. Install via SillyTavern's extension installer or place this repo as a third-party extension.
2. Reload SillyTavern.
3. Open Extensions → State Engine.

## Basic usage

1. Enable State Engine.
2. Pick/create presets, then bind presets to the current chat.
3. Add or edit variables in the selected preset tab.
4. Optional: choose which presets appear in the floating tracker.
5. Reference values with macros:

```text
{{getvar::variable_name}}
```

## Triggers and automation

Preset-level triggers control when prompted/counter-style logic runs, including:

- startup
- new_chat
- chat_change
- user
- pre_generation
- ai
- group_draft

Prompted increments and prompted value updates are batched for efficiency.

## World info status

State Engine now includes foundation work for variable-driven world info filtering and condition editing. This is actively in progress and not yet considered final/stable behavior.

## Notes

- Existing user presets are never overwritten by seeded examples.
- Variables remain local to SillyTavern's variable storage model and do not spam visible chat.
