# State Engine v0.9.9 Test Script
## Preset Load Order & Variable Tracker Ordering

**Branch:** `stygiantechnica-laughing-adventure` ✓  
**Version:** 0.9.9  
**Changes:** Preset load order tracking + variable ordering fix

---

## Setup Before Testing
- Open SillyTavern with an active chat (e.g., "Rivalry of Mages Chronicler")
- Make sure you have at least 2 presets available (Tournament, Story Progression, Debug, etc.)
- Open State Engine Manager

---

## Test 1: Preset Activation Order (Main Issue Fix)
**Expected:** Tracker displays variables in the order presets were activated

### Steps:
1. **Deactivate all presets** (if any are active)
   - Open Manager → **Presets** tab
   - Toggle OFF any active presets
   - Verify tracker is empty or shows "No tracked variables"

2. **Activate Tournament preset FIRST**
   - Toggle Tournament ON
   - Status: `Activated "Tournament" for this chat.`
   - Check State Tracker: Should show Tournament's variables

3. **Activate Story Progression preset SECOND**
   - Toggle Story Progression ON
   - Status: `Activated "Story Progression" for this chat.`
   - Check State Tracker: **KEY TEST**
     - [ ] PASS: Tournament variables appear FIRST (at top)
     - [ ] PASS: Story Progression variables appear SECOND (below Tournament)
     - [ ] FAIL: Story Progression variables appear first
     - [ ] FAIL: Variables are alphabetically sorted (ignore activation order)

4. **Activate Debug preset THIRD**
   - Toggle Debug ON
   - Check State Tracker:
     - [ ] PASS: Tournament variables → Story Progression → Debug (in activation order)
     - [ ] FAIL: Variables out of order

---

## Test 2: Variable Order Within Preset
**Expected:** Variables in tracker match their order in Manager's "Tracker order" sort

### Steps:
1. Open Manager → **Variables** tab
2. Make sure **Story Progression** preset is selected in dropdown
3. Change sort to **"Tracker order"** (default)
   - Note the order of variables in the list (top to bottom)
4. Open State Tracker panel (minimize manager if needed)
5. **Compare order:**
   - [ ] PASS: Story Progression's variables appear in same order as Manager list
   - [ ] FAIL: Variables are re-sorted alphabetically
   - [ ] FAIL: Variables out of order

---

## Test 3: Deactivate & Re-activate (Verify Persistence)
**Expected:** Load order is maintained correctly through toggles

### Steps:
1. In Manager, toggle Tournament OFF
   - Tracker should remove Tournament's variables
   - Story Progression and Debug variables remain (in order)
2. Toggle Tournament back ON
3. Check State Tracker:
   - [ ] PASS: Tournament variables re-appear at TOP (end of load order since re-activated last)
   - [ ] FAIL: Tournament re-appears in middle or maintains old position

---

## Test 4: Check Debug Info (Verify Data Structure)
**Expected:** Debug JSON shows new load order structure

### Steps:
1. Open Manager → **Debug** tab
2. Click **Copy JSON to Clipboard**
3. Paste and search for `"chatPresetBindings"`
4. Look for your chat ID entry:
   ```json
   "Rivalry of Mages Chronicler - ...": {
       "presetIds": ["id1", "id2", "id3"],
       "presetLoadOrder": ["id1", "id2", "id3"]
   }
   ```
5. **VERIFY:**
   - [ ] PASS: Structure has `presetIds` array
   - [ ] PASS: Structure has `presetLoadOrder` array (in activation order)
   - [ ] PASS: presetLoadOrder matches tracker display order
   - [ ] FAIL: Still shows old format (just an array)
   - [ ] FAIL: Order doesn't match what you see in tracker

---

## Success Criteria
✅ All tests PASS = Preset load order and variable ordering is fixed!

| Test | Expected | Result |
|------|----------|--------|
| 1a. Activation order | Tournament → Story → Debug | PASS / FAIL |
| 1b. Multiple preset order | Matches activation sequence | PASS / FAIL |
| 2. Variable order | Matches Manager "Tracker order" | PASS / FAIL |
| 3. Re-activation | New preset goes to end of order | PASS / FAIL |
| 4. Debug structure | Has presetLoadOrder array | PASS / FAIL |

---

## Troubleshooting
- **Tracker not updating?** Refresh the page (Ctrl+F5) and try again
- **Order still wrong?** Check Debug JSON to verify the load order was saved correctly
- **Variables alphabetical?** There's still a sort() call somewhere—let me know the order and which preset

---

## Quick Reference
- **State Tracker Location:** Left panel (can be dragged)
- **Manager → Variables Tab:** Shows "Tracker order" sort option
- **Debug Tab Location:** Manager → Debug → Copy JSON button
- **Version Check:** manifest.json should show "0.9.9"

