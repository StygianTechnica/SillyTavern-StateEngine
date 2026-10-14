// State Engine - the Scene Context starter preset: where the scene is (a location
// object - scene-location-migration.js converts older installs), who is in it,
// its title, tags, summary, weather, temperature, indoor/outdoor, the time passed
// each turn and the derived weather flags. Restored with the other starter presets
// (preset-manager.js getStarterPresetBlueprints). Variable names are local here -
// seeding qualifies them as se__<name>; expressions and dependencies already name
// the qualified variables they read.
//
// Generated from a working Scene Context preset; edit the preset in the manager and
// regenerate rather than hand-editing the definitions below.

export const SCENE_CONTEXT_BLUEPRINT = Object.freeze({
    "name": "Scene Context",
    "description": "The current scene: place, people, title, tags, summary, weather, temperature, indoors or out, and the time that passes each turn.",
    "triggers": [
        "ai"
    ],
    "showInTracker": false,
    "vars": [
        {
            "name": "scene_is_dry",
            "label": "Is Dry",
            "description": "",
            "scope": "chat",
            "type": "calculated",
            "enumValues": [],
            "flagMode": false,
            "dependencies": [
                "se__scene_weather"
            ],
            "expression": "se__scene_weather.contains(\"Dry\")",
            "currentKeyVariable": "",
            "itemType": "any",
            "itemEnumValues": [],
            "itemSchema": {},
            "maxLength": null,
            "unique": false,
            "sorted": false,
            "calendar": "gregorian",
            "unit": "seconds",
            "datetimeMode": "full",
            "deltaSource": "",
            "timeSemanticMode": "none",
            "defaultValue": 0,
            "min": null,
            "max": null,
            "resetOnNewChat": false,
            "showInTracker": false,
            "behaviors": {
                "prompted": false,
                "increment": false
            },
            "increment": {
                "triggers": "ai"
            },
            "prompted": {
                "instructions": ""
            },
            "version": 1
        },
        {
            "name": "scene_is_windy",
            "label": "Is Windy",
            "description": "",
            "scope": "chat",
            "type": "calculated",
            "enumValues": [],
            "flagMode": false,
            "dependencies": [
                "se__scene_weather"
            ],
            "expression": "se__scene_weather.contains(\"Windy\")",
            "currentKeyVariable": "",
            "itemType": "any",
            "itemEnumValues": [],
            "itemSchema": {},
            "maxLength": null,
            "unique": false,
            "sorted": false,
            "calendar": "gregorian",
            "unit": "seconds",
            "datetimeMode": "full",
            "deltaSource": "",
            "timeSemanticMode": "none",
            "defaultValue": 0,
            "min": null,
            "max": null,
            "resetOnNewChat": false,
            "showInTracker": false,
            "behaviors": {
                "prompted": false,
                "increment": false
            },
            "increment": {
                "triggers": "ai"
            },
            "prompted": {
                "instructions": ""
            },
            "version": 1
        },
        {
            "name": "scene_is_burning",
            "label": "Is Burning",
            "description": "",
            "scope": "chat",
            "type": "calculated",
            "enumValues": [],
            "flagMode": false,
            "dependencies": [
                "se__scene_temperature"
            ],
            "expression": "se__scene_temperature == \"Scorching\"",
            "currentKeyVariable": "",
            "itemType": "any",
            "itemEnumValues": [],
            "itemSchema": {},
            "maxLength": null,
            "unique": false,
            "sorted": false,
            "calendar": "gregorian",
            "unit": "seconds",
            "datetimeMode": "full",
            "deltaSource": "",
            "timeSemanticMode": "none",
            "defaultValue": 0,
            "min": null,
            "max": null,
            "resetOnNewChat": false,
            "showInTracker": false,
            "behaviors": {
                "prompted": false,
                "increment": false
            },
            "increment": {
                "triggers": "ai"
            },
            "prompted": {
                "instructions": ""
            },
            "version": 1
        },
        {
            "name": "scene_is_foggy",
            "label": "Is Foggy",
            "description": "",
            "scope": "chat",
            "type": "calculated",
            "enumValues": [],
            "flagMode": false,
            "dependencies": [
                "se__scene_weather"
            ],
            "expression": "se__scene_weather.contains(\"Foggy\")",
            "currentKeyVariable": "",
            "itemType": "any",
            "itemEnumValues": [],
            "itemSchema": {},
            "maxLength": null,
            "unique": false,
            "sorted": false,
            "calendar": "gregorian",
            "unit": "seconds",
            "datetimeMode": "full",
            "deltaSource": "",
            "timeSemanticMode": "none",
            "defaultValue": 0,
            "min": null,
            "max": null,
            "resetOnNewChat": false,
            "showInTracker": false,
            "behaviors": {
                "prompted": false,
                "increment": false
            },
            "increment": {
                "triggers": "ai"
            },
            "prompted": {
                "instructions": ""
            },
            "version": 1
        },
        {
            "name": "scene_is_hailing",
            "label": "Is Hailing",
            "description": "",
            "scope": "chat",
            "type": "calculated",
            "enumValues": [],
            "flagMode": false,
            "dependencies": [
                "se__scene_weather"
            ],
            "expression": "se__scene_weather.contains(\"Hailing\")",
            "currentKeyVariable": "",
            "itemType": "any",
            "itemEnumValues": [],
            "itemSchema": {},
            "maxLength": null,
            "unique": false,
            "sorted": false,
            "calendar": "gregorian",
            "unit": "seconds",
            "datetimeMode": "full",
            "deltaSource": "",
            "timeSemanticMode": "none",
            "defaultValue": 0,
            "min": null,
            "max": null,
            "resetOnNewChat": false,
            "showInTracker": false,
            "behaviors": {
                "prompted": false,
                "increment": false
            },
            "increment": {
                "triggers": "ai"
            },
            "prompted": {
                "instructions": ""
            },
            "version": 1
        },
        {
            "name": "scene_is_snowy",
            "label": "Is Snowy",
            "description": "",
            "scope": "chat",
            "type": "calculated",
            "enumValues": [],
            "flagMode": false,
            "dependencies": [
                "se__scene_weather"
            ],
            "expression": "se__scene_weather.contains(\"Snowy\")",
            "currentKeyVariable": "",
            "itemType": "any",
            "itemEnumValues": [],
            "itemSchema": {},
            "maxLength": null,
            "unique": false,
            "sorted": false,
            "calendar": "gregorian",
            "unit": "seconds",
            "datetimeMode": "full",
            "deltaSource": "",
            "timeSemanticMode": "none",
            "defaultValue": 0,
            "min": null,
            "max": null,
            "resetOnNewChat": false,
            "showInTracker": false,
            "behaviors": {
                "prompted": false,
                "increment": false
            },
            "increment": {
                "triggers": "ai"
            },
            "prompted": {
                "instructions": ""
            },
            "version": 1
        },
        {
            "name": "scene_is_stormy",
            "label": "Is Stormy",
            "description": "",
            "scope": "chat",
            "type": "calculated",
            "enumValues": [],
            "flagMode": false,
            "dependencies": [
                "se__scene_weather"
            ],
            "expression": "se__scene_weather.contains(\"Stormy\") || se__scene_weather.contains(\"Thunderstorm\")",
            "currentKeyVariable": "",
            "itemType": "any",
            "itemEnumValues": [],
            "itemSchema": {},
            "maxLength": null,
            "unique": false,
            "sorted": false,
            "calendar": "gregorian",
            "unit": "seconds",
            "datetimeMode": "full",
            "deltaSource": "",
            "timeSemanticMode": "none",
            "defaultValue": 0,
            "min": null,
            "max": null,
            "resetOnNewChat": false,
            "showInTracker": true,
            "behaviors": {
                "prompted": false,
                "increment": false
            },
            "increment": {
                "triggers": "ai"
            },
            "prompted": {
                "instructions": ""
            },
            "version": 1
        },
        {
            "name": "scene_is_drizzle",
            "label": "Is Drizzling",
            "description": "",
            "scope": "chat",
            "type": "calculated",
            "enumValues": [],
            "flagMode": false,
            "dependencies": [
                "se__scene_weather"
            ],
            "expression": "se__scene_weather.contains(\"Drizzle\")",
            "currentKeyVariable": "",
            "itemType": "any",
            "itemEnumValues": [],
            "itemSchema": {},
            "maxLength": null,
            "unique": false,
            "sorted": false,
            "calendar": "gregorian",
            "unit": "seconds",
            "datetimeMode": "full",
            "deltaSource": "",
            "timeSemanticMode": "none",
            "defaultValue": 0,
            "min": null,
            "max": null,
            "resetOnNewChat": false,
            "showInTracker": false,
            "behaviors": {
                "prompted": false,
                "increment": false
            },
            "increment": {
                "triggers": "ai"
            },
            "prompted": {
                "instructions": ""
            },
            "version": 1
        },
        {
            "name": "scene_is_raining",
            "label": "Is Raining",
            "description": "",
            "scope": "chat",
            "type": "calculated",
            "enumValues": [],
            "flagMode": false,
            "dependencies": [
                "se__scene_weather"
            ],
            "expression": "se__scene_weather.contains(\"Rainy\")",
            "currentKeyVariable": "",
            "itemType": "any",
            "itemEnumValues": [],
            "itemSchema": {},
            "maxLength": null,
            "unique": false,
            "sorted": false,
            "calendar": "gregorian",
            "unit": "seconds",
            "datetimeMode": "full",
            "deltaSource": "",
            "timeSemanticMode": "none",
            "defaultValue": 0,
            "min": null,
            "max": null,
            "resetOnNewChat": false,
            "showInTracker": false,
            "behaviors": {
                "prompted": false,
                "increment": false
            },
            "increment": {
                "triggers": "ai"
            },
            "prompted": {
                "instructions": ""
            },
            "version": 1
        },
        {
            "name": "scene_id",
            "label": "Scene Id",
            "description": "",
            "scope": "chat",
            "type": "string",
            "enumValues": [],
            "flagMode": false,
            "dependencies": [],
            "expression": "",
            "currentKeyVariable": "",
            "itemType": "any",
            "itemEnumValues": [],
            "itemSchema": {},
            "maxLength": null,
            "unique": false,
            "sorted": false,
            "calendar": "gregorian",
            "unit": "seconds",
            "datetimeMode": "full",
            "deltaSource": "",
            "timeSemanticMode": "none",
            "defaultValue": "",
            "min": null,
            "max": null,
            "resetOnNewChat": false,
            "showInTracker": true,
            "behaviors": {
                "increment": false,
                "prompted": true
            },
            "increment": {
                "delta": 1,
                "deltaVariable": "",
                "triggers": [
                    "ai"
                ],
                "tick_mode": null,
                "tick_on": "both",
                "tick_every": 1,
                "operation": null
            },
            "prompted": {
                "instructions": "The major place the characters are in now, as a short stable id: lowercase words joined by underscores (e.g. \"maple_heights_gym\", \"city_bus\", \"lucians_apartment\").\nIf the current value is empty, give the id of the place they are in now.\nOtherwise change it ONLY when the characters have gone to a different major place - another building, vehicle, street, district or town.\nMoving within the same place (another room, the entrance, the front desk of the same gym) is NOT a new place: repeat the current value exactly, character for character."
            },
            "version": 1
        },
        {
            "name": "scene_temperature",
            "label": "Temperature",
            "description": "",
            "scope": "chat",
            "type": "enum",
            "enumValues": [
                "Freezing",
                "Cold",
                "Cool",
                "Mild",
                "Warm",
                "Hot",
                "Scorching"
            ],
            "flagMode": false,
            "dependencies": [],
            "expression": "",
            "currentKeyVariable": "",
            "itemType": "any",
            "itemEnumValues": [],
            "itemSchema": {},
            "maxLength": null,
            "unique": false,
            "sorted": false,
            "calendar": "gregorian",
            "unit": "seconds",
            "datetimeMode": "full",
            "deltaSource": "",
            "timeSemanticMode": "none",
            "defaultValue": "",
            "min": null,
            "max": null,
            "resetOnNewChat": false,
            "showInTracker": true,
            "behaviors": {
                "increment": false,
                "prompted": true
            },
            "increment": {
                "delta": 1,
                "deltaVariable": "",
                "triggers": [
                    "ai"
                ],
                "tick_mode": null,
                "tick_on": "both",
                "tick_every": 1,
                "operation": null
            },
            "prompted": {
                "instructions": "Select which temperature value most closely reflects the temperature experienced by characters in the scene."
            },
            "version": 1
        },
        {
            "name": "scene_characters",
            "label": "Scene Characters",
            "description": "",
            "scope": "chat",
            "type": "array",
            "enumValues": [],
            "flagMode": false,
            "dependencies": [],
            "expression": "",
            "currentKeyVariable": "",
            "itemType": "object",
            "itemEnumValues": [],
            "itemSchema": {},
            "maxLength": null,
            "unique": true,
            "sorted": false,
            "calendar": "gregorian",
            "unit": "seconds",
            "datetimeMode": "full",
            "deltaSource": "",
            "timeSemanticMode": "none",
            "defaultValue": "[]",
            "min": null,
            "max": null,
            "resetOnNewChat": false,
            "showInTracker": true,
            "behaviors": {
                "increment": false,
                "prompted": true
            },
            "increment": {
                "operation": null
            },
            "prompted": {
                "instructions": "Update this list based on the current scene.  Keep characters who remain present. Add characters newly introduced. Remove characters who have left."
            },
            "version": 1,
            "itemObjectType": "character"
        },
        {
            "name": "scene_title",
            "label": "Scene Title",
            "description": "",
            "scope": "chat",
            "type": "string",
            "enumValues": [],
            "flagMode": false,
            "dependencies": [],
            "expression": "",
            "currentKeyVariable": "",
            "itemType": "any",
            "itemEnumValues": [],
            "itemSchema": {},
            "maxLength": null,
            "unique": false,
            "sorted": false,
            "calendar": "gregorian",
            "unit": "seconds",
            "datetimeMode": "full",
            "deltaSource": "",
            "timeSemanticMode": "none",
            "defaultValue": "",
            "min": null,
            "max": null,
            "resetOnNewChat": false,
            "showInTracker": true,
            "behaviors": {
                "increment": false,
                "prompted": true
            },
            "increment": {
                "delta": 1,
                "deltaVariable": "",
                "triggers": [
                    "ai"
                ],
                "tick_mode": null,
                "tick_on": "both",
                "tick_every": 1,
                "operation": null
            },
            "prompted": {
                "instructions": "Based on the last 10 messages and the current value, generate a short scene title summarizing the current situation."
            },
            "version": 1
        },
        {
            "name": "scene_tags",
            "label": "Tags",
            "description": "",
            "scope": "chat",
            "type": "array",
            "enumValues": [],
            "flagMode": false,
            "dependencies": [],
            "expression": "",
            "currentKeyVariable": "",
            "itemType": "string",
            "itemEnumValues": [],
            "itemSchema": {},
            "maxLength": null,
            "unique": true,
            "sorted": true,
            "calendar": "gregorian",
            "unit": "seconds",
            "datetimeMode": "full",
            "deltaSource": "",
            "timeSemanticMode": "none",
            "defaultValue": "[]",
            "min": null,
            "max": null,
            "resetOnNewChat": false,
            "showInTracker": true,
            "behaviors": {
                "increment": false,
                "prompted": true
            },
            "increment": {
                "operation": null
            },
            "prompted": {
                "instructions": "Look only at the most recent roleplay message.\nExtract 1–3 short descriptors that describe the scene’s atmosphere, tone, or environmental qualities.\nUse single words or very short phrases (e.g., “tense”, “quiet”, “smoky”, “crowded”).\nOnly update this variable if the message explicitly describes the scene’s mood or environment.\nIf the message does not describe the scene, do not change this variable."
            },
            "version": 1
        },
        {
            "name": "scene_summary",
            "label": "Summary",
            "description": "",
            "scope": "chat",
            "type": "string",
            "enumValues": [],
            "flagMode": false,
            "dependencies": [],
            "expression": "",
            "currentKeyVariable": "",
            "itemType": "any",
            "itemEnumValues": [],
            "itemSchema": {},
            "maxLength": null,
            "unique": false,
            "sorted": false,
            "calendar": "gregorian",
            "unit": "seconds",
            "datetimeMode": "full",
            "deltaSource": "",
            "timeSemanticMode": "none",
            "defaultValue": "",
            "min": null,
            "max": null,
            "resetOnNewChat": false,
            "showInTracker": true,
            "behaviors": {
                "increment": false,
                "prompted": true
            },
            "increment": {
                "delta": 1,
                "deltaVariable": "",
                "triggers": [
                    "ai"
                ],
                "tick_mode": null,
                "tick_on": "both",
                "tick_every": 1,
                "operation": null
            },
            "prompted": {
                "instructions": "Summarize the current scene based on the recent roleplay messages.\nFocus only on the last few messages that describe the environment or situation.\nDo not summarize the entire chat history."
            },
            "version": 1
        },
        {
            "name": "scene_isindoor",
            "label": "Is Indoor",
            "description": "",
            "scope": "chat",
            "type": "boolean",
            "enumValues": [],
            "flagMode": false,
            "dependencies": [],
            "expression": "",
            "currentKeyVariable": "",
            "itemType": "any",
            "itemEnumValues": [],
            "itemSchema": {},
            "maxLength": null,
            "unique": false,
            "sorted": false,
            "calendar": "gregorian",
            "unit": "seconds",
            "datetimeMode": "full",
            "deltaSource": "",
            "timeSemanticMode": "none",
            "defaultValue": "",
            "min": null,
            "max": null,
            "resetOnNewChat": false,
            "showInTracker": true,
            "behaviors": {
                "increment": false,
                "prompted": true
            },
            "increment": {
                "delta": 1,
                "triggers": [
                    "ai"
                ],
                "tick_mode": null,
                "tick_on": "both",
                "tick_every": 1,
                "operation": null
            },
            "prompted": {
                "instructions": "Infer whether the scene is indoors or outdoors based on the recent roleplay messages.\nUse explicit environmental cues (e.g., “inside the tavern”, “under the open sky”).\nIf no cues appear in recent messages, leave this variable unchanged."
            },
            "version": 1
        },
        {
            "name": "scene_weather",
            "label": "Weather",
            "description": "",
            "scope": "chat",
            "type": "array",
            "enumValues": [],
            "flagMode": false,
            "dependencies": [],
            "expression": "",
            "currentKeyVariable": "",
            "itemType": "enum",
            "itemEnumValues": [
                "Clear",
                "Sunny",
                "Partly Cloudy",
                "Overcast",
                "Rainy",
                "Stormy",
                "Thunderstorm",
                "Snowy",
                "Windy",
                "Foggy",
                "Hazy",
                "Humid",
                "Dry",
                "Drizzle",
                "Hailing"
            ],
            "itemSchema": {},
            "maxLength": null,
            "unique": true,
            "sorted": false,
            "calendar": "gregorian",
            "unit": "seconds",
            "datetimeMode": "full",
            "deltaSource": "",
            "timeSemanticMode": "none",
            "defaultValue": "[]",
            "min": null,
            "max": null,
            "resetOnNewChat": false,
            "showInTracker": true,
            "behaviors": {
                "increment": false,
                "prompted": true
            },
            "increment": {
                "operation": null
            },
            "prompted": {
                "instructions": "For the messages in the last turn,\nIdentify any explicit environmental cues that describe weather (e.g., “overcast”, “smoky”, “drizzling”, “clear sky”, “wind picking up”).\nMap each cue to one or more values from the allowed weather enum list.\nCombine consistent cues into an array of selected weather values.\nDo not infer weather from tone, mood, or metaphor — only explicit environmental descriptions.\nIf no recent messages describe the weather, leave this variable unchanged.\n"
            },
            "version": 1
        },
        {
            "name": "scene_location",
            "label": "Location",
            "description": "The place the scene is in - a location object.",
            "scope": "chat",
            "type": "object",
            "objectType": "location",
            "enumValues": [],
            "flagMode": false,
            "dependencies": [],
            "expression": "",
            "currentKeyVariable": "",
            "itemType": "any",
            "itemEnumValues": [],
            "itemSchema": {},
            "maxLength": null,
            "unique": false,
            "sorted": false,
            "calendar": "gregorian",
            "unit": "seconds",
            "datetimeMode": "full",
            "deltaSource": "",
            "timeSemanticMode": "none",
            "defaultValue": "",
            "min": null,
            "max": null,
            "resetOnNewChat": false,
            "showInTracker": true,
            "behaviors": {
                "increment": false,
                "prompted": true
            },
            "increment": {
                "delta": 1,
                "triggers": [
                    "ai"
                ],
                "tick_mode": null,
                "tick_on": "both",
                "tick_every": 1,
                "operation": null
            },
            "prompted": {
                "instructions": "The specific place the scene is in right now - the most specific named or uniquely described place (a room, building or street rather than the whole city).\nChange it only when the characters move or a new place is explicitly named or strongly implied; otherwise keep the current one."
            },
            "version": 1
        },
        {
            "name": "scene_deltatime",
            "label": "Delta Time",
            "description": "",
            "scope": "chat",
            "type": "string",
            "enumValues": [],
            "flagMode": false,
            "dependencies": [],
            "expression": "",
            "currentKeyVariable": "",
            "itemType": "any",
            "itemEnumValues": [],
            "itemSchema": {},
            "maxLength": null,
            "unique": false,
            "sorted": false,
            "calendar": "gregorian",
            "unit": "seconds",
            "datetimeMode": "full",
            "deltaSource": "",
            "timeSemanticMode": "none",
            "defaultValue": "",
            "min": null,
            "max": null,
            "resetOnNewChat": false,
            "showInTracker": true,
            "behaviors": {
                "increment": false,
                "prompted": true
            },
            "increment": {
                "delta": 1,
                "deltaVariable": "",
                "triggers": [
                    "ai"
                ],
                "tick_mode": null,
                "tick_on": "both",
                "tick_every": 1,
                "operation": null
            },
            "prompted": {
                "instructions": "How much in-story time passed across the whole Latest turn - every message in it, the user’s included. Count everything that takes time: talking (a few minutes), travel, waiting, work, sleep, and any skip the story makes (“hours later”, “the next day”). Answer a duration (“5 minutes”, “2 hours”, “3 days”) or, when the story moves on to a time of day, that time of day (“the next morning”, “that evening”, “tomorrow afternoon”, “until dawn”). Drop hedging words (“about half an hour” → “30 minutes”). Answer “” only if no time passed at all."
            },
            "version": 1
        },
        {
            "name": "scene_currenttime",
            "label": "Current Time",
            "description": "",
            "scope": "chat",
            "type": "datetime",
            "enumValues": [],
            "flagMode": false,
            "dependencies": [],
            "expression": "",
            "currentKeyVariable": "",
            "itemType": "any",
            "itemEnumValues": [],
            "itemSchema": {},
            "maxLength": null,
            "unique": false,
            "sorted": false,
            "calendar": "gregorian",
            "unit": "seconds",
            "datetimeMode": "timeOnly",
            "deltaSource": "se__scene_deltatime",
            "timeSemanticMode": "semanticTimeOfDay",
            "defaultValue": 0,
            "min": null,
            "max": null,
            "resetOnNewChat": false,
            "showInTracker": true,
            "behaviors": {
                "increment": false,
                "prompted": false
            },
            "increment": {
                "delta": "1",
                "deltaVariable": "",
                "triggers": "ai"
            },
            "prompted": {
                "instructions": ""
            },
            "version": 1
        },
        {
            "name": "scene_currentdate",
            "label": "Current Date",
            "description": "",
            "scope": "chat",
            "type": "datetime",
            "enumValues": [],
            "flagMode": false,
            "dependencies": [],
            "expression": "",
            "currentKeyVariable": "",
            "itemType": "any",
            "itemEnumValues": [],
            "itemSchema": {},
            "maxLength": null,
            "unique": false,
            "sorted": false,
            "calendar": "gregorian",
            "unit": "seconds",
            "datetimeMode": "dateOnly",
            "deltaSource": "se__scene_deltatime",
            "timeSemanticMode": "semanticTimeOfDay",
            "defaultValue": 1663977600,
            "min": null,
            "max": null,
            "resetOnNewChat": false,
            "showInTracker": true,
            "behaviors": {
                "increment": false,
                "prompted": false
            },
            "increment": {
                "delta": "1",
                "deltaVariable": "",
                "triggers": "ai"
            },
            "prompted": {
                "instructions": ""
            },
            "version": 1
        }
    ]
});
