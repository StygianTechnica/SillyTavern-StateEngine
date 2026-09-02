# State Engine

State Engine is a SillyTavern extension for local state tracking with reusable preset toolkits, strict typing, and automated updates.

Current branch version: `0.9.12`

## What it does

- Stores variables in SillyTavern's native variable store
- Supports per-chat preset binding with activation order
- Exposes values through macros like `{{getvar::name}}`
- Updates values via manual actions, counters, cycling sequences, or prompted AI decisions
- Shows a floating tracker panel for active variables
- Provides a manager modal for presets, variables, triggers, and world-info conditions
- Prompted variables can be marked to skip refresh when needed

## Entry points

- **Extensions menu**: open State Engine from the main extensions/settings area
- **Chat tool**: the `State Engine` chat tool opens a submenu with:
  - `Tracker`
  - `Manager`

## Basic usage

1. Enable State Engine.
2. Create or restore presets.
3. Bind presets to the current chat.
4. Add or edit variables in the manager.
5. Optionally show selected presets in the floating tracker.

## Seeded starter presets

On first run, State Engine can seed example presets:

1. Story Progression
2. Location and Time
3. Relationships
4. Combat and Encounter
5. Mixed Showcase

## Triggers and automation

Preset-level triggers include:

- startup
- new_chat
- chat_change
- user
- pre_generation
- ai
- group_draft

## Notes

- Existing user presets are not overwritten by seeded examples.
- Variables remain local to SillyTavern and do not add visible chat messages.
- World info condition support is present but still evolving.
