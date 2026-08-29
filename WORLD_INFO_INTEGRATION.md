# World Info Variable Conditions — Design & Integration Guide

## Vision

Transform world info from passive keyword matching to **active state-dependent content**. Variables become switches that control narrative flow.

**Before:** "Arena rules" entry shows whenever someone mentions "arena"  
**After:** "Arena rules" entry shows only when `tournament_active = true` (AI reacts to situational context)

**Result:** Portents, omens, conditional events, and narrative-aware content without keyword pollution.

---

## Architecture Overview

### 1. Data Model

**Storage Location:** Separate from State Engine settings; lives with world info entries  
**Key Insight:** Each world info entry (uid) can have multiple variable conditions

```javascript
// SillyTavern native stores world info in: context.worldInfo.entries
// We'll store conditions in: context.extensionSettings['state_engine'].wiConditions

{
  wiConditions: {
    "entry_uid_1": [
      { variable: "tournament_active", operator: "equals", value: "true" },
      { variable: "tournament_phase", operator: "equals", value: "finals" }
    ],
    "entry_uid_2": [
      { variable: "relationship_status", operator: "not_equals", value: "unknown" }
    ]
  }
}

// Conditions evaluate as AND (all must be true for entry to display)
// Multiple conditions on same entry: ALL must match
// If entry has no conditions: always displays (backward compatible)
```

### 2. Condition Evaluation Engine

**Function:** `evaluateCondition(variable, operator, value)`

```javascript
const CONDITION_OPERATORS = {
  'equals': (varValue, condValue) => varValue == condValue,
  'not_equals': (varValue, condValue) => varValue != condValue,
  'greater_than': (varValue, condValue) => Number(varValue) > Number(condValue),
  'less_than': (varValue, condValue) => Number(varValue) < Number(condValue),
  'contains': (varValue, condValue) => String(varValue).includes(condValue),
  'regex': (varValue, condValue) => new RegExp(condValue).test(varValue),
  'in_list': (varValue, condValue) => condValue.split(',').includes(varValue),
  'true': (varValue) => varValue == true || varValue === 'true' || varValue == 1,
  'false': (varValue) => varValue == false || varValue === 'false' || varValue == 0,
};

function evaluateConditions(entryUid) {
  const conditions = wiConditions[entryUid] || [];
  if (conditions.length === 0) return true; // No conditions = always show
  
  return conditions.every(cond => {
    const varValue = getVarValue(cond.variable);
    const operator = CONDITION_OPERATORS[cond.operator];
    return operator(varValue, cond.value);
  });
}
```

### 3. Integration Points

#### Hook Point 1: World Info Entry Rendering
SillyTavern has event: `WORLD_INFO_BEFORE_DISPLAY` (or similar)
- Listen for this event
- Evaluate conditions for each entry
- Remove entries that fail conditions
- Return filtered entries

#### Hook Point 2: API Intercept
When context is being built for LLM:
- Hook into `getWorldInfoContext()` or equivalent
- Filter entries before they're added to context
- Log which entries were filtered and why (for debugging)

#### Hook Point 3: Extension Panel UI
When user views world info entries:
- Add "Show when" column/section
- Display current conditions for each entry
- Show "Active" badge if conditions currently met

---

## Implementation Phases

### Phase 1: Data Model & Storage (1-2 hours)
**Goal:** Store and retrieve conditions without breaking anything

1. Add `wiConditions: {}` to DEFAULT_SETTINGS
2. Create getter/setter functions:
   - `getWIConditions(entryUid)` → returns condition array
   - `setWICondition(entryUid, condition)` → adds/updates condition
   - `deleteWICondition(entryUid, conditionIndex)` → removes condition
   - `clearWIConditionsForEntry(entryUid)` → removes all conditions

3. Implement `evaluateCondition()` with all operators
4. Test: Can store/retrieve conditions without UI yet

### Phase 2: Filter Hook (1-2 hours)
**Goal:** Intercept world info loading and filter entries

1. Research SillyTavern's world info API:
   - How are entries accessed? (`context.worldInfo.entries`?)
   - What events fire during context building?
   - Can we hook before entries are added to context?

2. Implement filtering function:
   ```javascript
   function filterWorldInfoEntries(entries) {
     return entries.filter(entry => evaluateConditions(entry.uid || entry.id));
   }
   ```

3. Hook into the right event/API call
4. Test: Entries with failing conditions don't appear in context

### Phase 3: UI Editor (2-3 hours)
**Goal:** Let user manage conditions in the extension panel

1. Design UI mockup:
   - Table in extension panel: Entry Name | Conditions | Add Condition
   - Modal dialog to add condition:
     - Variable dropdown (populated from current presets)
     - Operator dropdown (equals, not_equals, etc.)
     - Value input field
     - Preview: "Show when [variable] [operator] [value]"

2. Implement in settings.html:
   - New section: "World Info Conditions"
   - Entry list with condition editing
   - Live preview of conditions

3. Implement in index.js:
   - `openWIConditionEditor(entryUid)`
   - `saveWICondition(entryUid, condition)`
   - `renderWIConditionsList()`

### Phase 4: Integration & Testing (1-2 hours)
**Goal:** Wire everything together and test end-to-end

1. Test with actual world info entries
2. Test condition operators:
   - `tournament_active = true` (boolean)
   - `tournament_phase = finals` (enum)
   - `relationship_closeness > 50` (number)
3. Debug any edge cases
4. Version bump to v0.5.0

---

## Key Design Decisions

### Why separate storage?
- World info is managed by SillyTavern's world info system
- Attaching conditions as a new field requires modifying SillyTavern's data model
- Better to keep it separate in extension settings, keyed by entry UID
- No dependency on SillyTavern world info schema changes

### Why AND logic for multiple conditions?
- Simpler mental model: "Show when X = 1 AND Y = 2" is clearer than "Show when X = 1 OR Y = 2"
- Can always add OR logic in future by allowing condition groups
- Matches typical role-playing use case: "Show this lore only if player is in location AND has power activated"

### Backward compatibility?
- If entry has no conditions → always displays (existing behavior)
- Migration: nothing needed (conditions start empty)
- Graceful degradation: if State Engine disabled, world info works normally

### Performance?
- Evaluation is O(n*m) where n = entries, m = conditions per entry
- Typical: <100 entries, <5 conditions/entry = <500 evaluations = ~1ms
- Negligible impact on context building

### What about dynamic conditions?
- Future: Allow conditions to reference other variables
- Future: Allow weighted probabilities ("show 50% of the time")
- For now: Keep it simple (variable = specific value)

---

## API Reference (To Implement)

### Core Functions

```javascript
// Get conditions for a world info entry
function getWIConditions(entryUid) {
  return getSettings().wiConditions[entryUid] || [];
}

// Add/update a condition
function setWICondition(entryUid, condition) {
  const settings = getSettings();
  if (!settings.wiConditions[entryUid]) {
    settings.wiConditions[entryUid] = [];
  }
  settings.wiConditions[entryUid].push(condition);
  saveSettings(settings);
}

// Remove a condition
function deleteWICondition(entryUid, conditionIndex) {
  const settings = getSettings();
  if (settings.wiConditions[entryUid]) {
    settings.wiConditions[entryUid].splice(conditionIndex, 1);
    if (settings.wiConditions[entryUid].length === 0) {
      delete settings.wiConditions[entryUid];
    }
    saveSettings(settings);
  }
}

// Evaluate whether entry should display
function shouldDisplayWIEntry(entryUid) {
  const conditions = getWIConditions(entryUid);
  if (conditions.length === 0) return true;
  
  return conditions.every(cond => {
    const varValue = getVarValue(cond.variable);
    const operator = CONDITION_OPERATORS[cond.operator];
    try {
      return operator(varValue, cond.value);
    } catch (e) {
      console.error(`[State Engine] Condition evaluation failed for ${entryUid}:`, e);
      return true; // Fail open (show entry) on error
    }
  });
}

// Filter world info entries
function filterWorldInfoByConditions(entries) {
  return entries.filter(entry => shouldDisplayWIEntry(entry.uid));
}
```

---

## Testing Checklist

- [ ] Condition storage persists across chat changes
- [ ] Condition evaluation returns true/false correctly
- [ ] All operators work (equals, not_equals, greater_than, etc.)
- [ ] Multiple conditions on same entry evaluated as AND
- [ ] Entries without conditions always display
- [ ] Filtered entries don't appear in LLM context
- [ ] UI shows all stored conditions correctly
- [ ] Can add/edit/delete conditions in UI
- [ ] Variables from all active presets available in condition editor
- [ ] Live preview shows current evaluation status

---

## Example Use Cases

### Tournament Tracker
```
Preset: Tournament
  - tournament_active (manual, boolean)
  - tournament_phase (cycling: sign-up → round-1 → round-2 → finals → concluded)
  - rounds_completed (counter)
  
World Info Entries:
  - "Arena Rules" → show when tournament_active = true
  - "Round {N} Bracket" → show when tournament_phase = [round-1, round-2]
  - "Finals Information" → show when tournament_phase = finals
```

### Relationship Tracking
```
Preset: Relationships
  - alice_trust_level (manual, number 0-100)
  - alice_revealed_secrets (counter, increments on "prompted")
  - alice_relationship_status (cycling: stranger → acquaintance → friend → confidant)

World Info Entries:
  - "Alice's Background" → show when alice_relationship_status != stranger
  - "Alice's Secret" → show when alice_revealed_secrets > 0 AND alice_trust_level > 50
```

### Location-Aware Content
```
Preset: World State
  - current_location (manual, enum: tavern/forest/castle/dungeons)
  - time_of_day (cycling: dawn → morning → noon → evening → night)
  - season (cycling: spring → summer → fall → winter)

World Info Entries:
  - "Tavern Regulars" → show when current_location = tavern
  - "Night Creatures" → show when time_of_day = night
  - "Winter Storms" → show when season = winter AND current_location != tavern
```

---

## Future Enhancements

1. **Condition Groups:** Allow OR logic (any condition must be true)
2. **Weighted Display:** "Show 70% of the time when condition met"
3. **Condition History:** Track when conditions became true/false over chat
4. **Bulk Management:** Apply same condition to multiple entries at once
5. **Condition Templates:** Save common conditions as reusable presets
6. **Conflict Detection:** Warn if two entries would never both display
7. **Analytics:** Show which entries are most/least often filtered
