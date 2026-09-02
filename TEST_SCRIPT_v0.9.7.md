# State Engine v0.9.7 Test Script
## Critical Tracker Binding Bug Fix

**Branch:** `stygiantechnica-laughing-adventure` ✓  
**Version:** 0.9.7  
**Changes:** getCurrentChatId exported to manager API, fixing preset→tracker binding

---

## MAIN TEST: Preset Variables Now Show in State Tracker

**Setup:**
- Open SillyTavern with a chat active (use "Rivalry of Mages Chronicler" if available)
- Open State Engine Manager
- Ensure you have some presets (Tournament, Debug, etc.) with variables defined

---

## Test 1: Activate Tournament Preset & Check Tracker
**Expected:** Variables from Tournament preset display in state tracker immediately

1. Click **Presets** tab
2. Find "Tournament" preset card
3. Toggle the preset **ON** (click toggle button)
   - Status should show: `Activated "Tournament" for this chat.`
   - Card should show "Active" label
4. Click **State Tracker** (minimize manager if needed to see tracker)
5. **VERIFY:** 
   - [ ] PASS: "something" variable from Tournament shows in tracker
   - [ ] PASS: Any other Tournament variables show in tracker
   - [ ] FAIL: Tracker is empty / doesn't update

---

## Test 2: Deactivate & Re-activate (Verify Binding)
**Expected:** Preset variables appear/disappear consistently

1. In Manager **Presets** tab, find Tournament preset
2. Toggle OFF
   - Status: `Deactivated "Tournament" for this chat.`
   - Tracker should clear Tournament variables
3. Toggle ON again
   - Status: `Activated "Tournament" for this chat.`
   - Tracker should re-populate with Tournament variables
4. **VERIFY:**
   - [ ] PASS: Variables disappear when toggled OFF
   - [ ] PASS: Variables reappear when toggled ON
   - [ ] FAIL: Variables don't update with toggle

---

## Test 3: Switch Presets & Verify Tracker Updates
**Expected:** Only active preset variables show in tracker

1. Ensure Tournament preset is ON
2. Verify variables show in tracker
3. Toggle Tournament OFF
4. Toggle a different preset (e.g., "Debug") ON
5. **VERIFY:**
   - [ ] PASS: Tracker shows Debug preset variables, not Tournament
   - [ ] PASS: Switching between presets updates tracker correctly
   - [ ] FAIL: Tracker shows mixed variables or doesn't update

---

## Test 4: Variables Tab Shows Active Presets
**Expected:** Manager defaults to showing active preset's variables

1. Open Manager → **Variables** tab
2. **VERIFY:**
   - [ ] PASS: Preset selector shows active preset by default
   - [ ] PASS: Variables list shows active preset's variables
   - [ ] FAIL: Shows wrong preset or empty list

---

## Test 5: Debug Info Confirms Binding
**Expected:** Debug JSON shows correct chatId (not "null")

1. Open Manager → **Debug** tab
2. Click **Copy JSON to Clipboard**
3. Paste into a text editor or log viewer
4. Look for `"chatPresetBindings"` section
5. **VERIFY:**
   - [ ] PASS: Presets bound to actual chatId (e.g., "Rivalry of Mages Chronicler - ...")
   - [ ] PASS: NOT bound to "null" or "undefined"
   - [ ] PASS: activePresets array contains actual preset IDs
   - [ ] FAIL: Still shows `"null"` or `"undefined"` keys in bindings

---

## Success Criteria
✅ All tests PASS = Bug is fixed!  
🔄 Toggle ON/OFF works consistently  
🎯 Tracker updates immediately when presets change  
📋 Debug JSON shows correct bindings  

---

## Quick Reference
- **Preset Toggle Button Location:** Presets tab → Card → Right side (Toggle icon)
- **State Tracker Location:** Left panel (minimize manager to see it)
- **Debug Info Location:** Manager → Debug tab → "Copy JSON" button
- **Version Check:** Manifest shows "0.9.7"

