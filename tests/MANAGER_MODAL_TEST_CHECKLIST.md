# Manager Modal Testing Checklist

## 🎯 Access & UI

- [ ] Manager button appears in drawer settings (between "Run prompted updates now" and status)
- [ ] Clicking drawer button opens manager modal
- [ ] `/state-manager` slash command opens manager modal
- [ ] Modal appears as overlay with dark background
- [ ] Modal closes when clicking X button (top right)
- [ ] Modal closes when clicking outside the window (dark overlay area)
- [ ] All 4 tab buttons visible: Presets, Variables, Triggers, World Info
- [ ] Tab buttons have icons (boxes, list, bolt, book)
- [ ] Active tab is highlighted with accent color

## 🎨 Theme & Styling

- [ ] Modal colors match SillyTavern theme (background, text, borders)
- [ ] Hover effects work on buttons and rows
- [ ] Accent color used for active tab and interactive elements
- [ ] Modal is readable in light and dark themes
- [ ] Modal responsive on smaller screens (width ~90%, max-width 1000px)
- [ ] Text is not cut off or overlapping

## 📦 Presets Tab

### Viewing
- [ ] All presets display in list format
- [ ] Each preset shows: name, triggers (e.g. "ai, user")
- [ ] "No presets yet" message appears when list is empty
- [ ] New/Restore buttons visible at top

### Creating Presets
- [ ] "New" button opens prompt for preset name
- [ ] Can enter preset name and confirm
- [ ] New preset appears in list immediately
- [ ] New preset is added to database (persists after reload)
- [ ] Status message shows "Created preset [name]"

### Cloning Presets
- [ ] Clone button (copy icon) works on each preset
- [ ] Prompt asks for new name (suggests "[name] (copy)")
- [ ] Cloned preset includes all variables from original
- [ ] Cloned preset includes trigger settings from original
- [ ] Cloned preset has different ID (independent)
- [ ] Status message shows clone succeeded

### Renaming Presets
- [ ] Rename button (pencil icon) works on each preset
- [ ] Prompt shows current name as default
- [ ] Renamed preset updates immediately
- [ ] Name persists after reload
- [ ] Status message shows rename succeeded

### Deleting Presets
- [ ] Delete button (trash icon) works on each preset
- [ ] Confirmation dialog appears with preset name
- [ ] Canceling deletion does nothing
- [ ] Confirmed deletion removes preset from list
- [ ] Variables in deleted preset are NOT deleted (only preset)
- [ ] If deleted preset was `currentPresetId`, it clears
- [ ] Status message confirms deletion

### Restore Defaults
- [ ] "Restore Defaults" button is present and clickable
- [ ] Clicking it asks for confirmation (or just restores)
- [ ] 5 example presets appear (Affection, Status, Mood, etc.)
- [ ] Message indicates how many presets were restored
- [ ] Can be run multiple times safely (idempotent)
- [ ] Existing presets are not overwritten

## 📝 Variables Tab

### Preset Selector
- [ ] Dropdown shows "-- Select preset --" initially
- [ ] Dropdown populates with all preset names
- [ ] Selecting a preset loads its variables
- [ ] `currentPresetId` updates when selected
- [ ] Selector remembers selected preset when switching tabs and back

### Variable List
- [ ] Empty state shows "No variables in this preset yet" when preset has none
- [ ] Each variable row shows:
  - [ ] Variable name (monospace font)
  - [ ] Category (manual, counter, cycling, prompted)
  - [ ] Type (number, string, boolean, enum, array)
  - [ ] Visibility (👁️ visible or 👁️ hidden)
- [ ] Variables are listed in some consistent order (or alphabetical)

### Adding Variables
- [ ] "New Variable" button is visible when preset selected
- [ ] "New Variable" button disabled/shows alert when no preset selected
- [ ] Clicking "New Variable" opens drawer editor (below manager)
- [ ] After saving variable in drawer, it appears in list
- [ ] Variable is correctly associated with selected preset

### Editing Variables
- [ ] Edit button (pencil icon) on each variable row
- [ ] Clicking edit opens drawer editor with current values
- [ ] Editor shows preset name (currentPresetId is set)
- [ ] Edits persist when saved
- [ ] Variables list refreshes with updated info
- [ ] Can edit name, type, category, default, etc.

### Deleting Variables
- [ ] Delete button (trash icon) on each variable row
- [ ] Confirmation dialog appears with variable name
- [ ] Confirmed deletion removes variable from preset
- [ ] Deleted variable does NOT affect other presets
- [ ] Variables list refreshes after deletion
- [ ] Status message confirms deletion

### Tracker Visibility Toggle
- [ ] Variables show current visibility state (👁️)
- [ ] Visibility is correct (showInTracker field)
- [ ] Can toggle visibility in drawer editor
- [ ] Tracker panel respects visibility changes

## ⚡ Triggers Tab

### Trigger Display
- [ ] Shows one section per preset (if any presets exist)
- [ ] Each section titled with preset name
- [ ] "No World Info conditions set yet" when no presets (or similar message)
- [ ] All 7 trigger types shown as checkboxes:
  - [ ] startup
  - [ ] new_chat
  - [ ] chat_change
  - [ ] user
  - [ ] pre_generation
  - [ ] ai
  - [ ] group_draft

### Configuring Triggers
- [ ] Checking a trigger adds it to preset.triggers
- [ ] Unchecking a trigger removes it from preset.triggers
- [ ] Triggers persist immediately (no save button needed)
- [ ] Triggers persist after reload
- [ ] Status message shows "Triggers updated for [preset name]"
- [ ] Can check/uncheck multiple triggers on same preset
- [ ] Changes to one preset don't affect others

### Trigger Persistence
- [ ] Variables in preset with triggers actually update on those events
- [ ] Triggered updates use the correct preset's variables
- [ ] Can set different triggers for different presets

## 🌍 World Info Tab

### Condition Display
- [ ] Shows list of all World Info entries with conditions
- [ ] Each entry shows:
  - [ ] World.uid key (monospace, full identifier)
  - [ ] Condition summary (e.g. "mood equals happy AND affection > 5")
- [ ] "No World Info conditions set yet" when none exist
- [ ] Displays up to 50 entries (reasonable limit)
- [ ] Conditions formatted readably (variable operator value)

### Condition Viewing
- [ ] Can see all conditions that have been set on WI entries
- [ ] Condition format is clear and human-readable
- [ ] Multiple conditions on same entry show all joined by AND
- [ ] Entries with no conditions show "No conditions"

## 🔄 Cross-Tab Behavior

- [ ] Switching tabs doesn't lose data from other tabs
- [ ] Preset selector in Variables tab persists across tab switches
- [ ] Tab content re-renders when switching to tab (fresh data)
- [ ] Creating preset in Presets tab updates Variables dropdown
- [ ] Triggers updated in Triggers tab show in Presets tab description
- [ ] World Info entries appear/disappear as conditions are set elsewhere

## 📊 Integration with Drawer UI

### Drawer Still Works
- [ ] Old drawer preset list still visible
- [ ] Drawer tabs (if any) still functional
- [ ] "Add variable" button in drawer still works
- [ ] Variable editor in drawer opens independently of modal
- [ ] Tracker panel still visible and draggable
- [ ] Tracker display toggles work
- [ ] Restore Defaults button works in drawer

### Data Sync
- [ ] Changes in manager modal appear in drawer UI
- [ ] Changes in drawer (add/edit variable) appear in modal
- [ ] Preset selection in drawer affects modal
- [ ] Variable table in drawer shows correct data

## 🐛 Edge Cases

### Empty States
- [ ] Works when no presets exist (all tabs show appropriate "empty" messages)
- [ ] Works when preset has no variables
- [ ] Works when preset has no triggers
- [ ] Works when no World Info conditions are set

### Boundary Cases
- [ ] Preset name can be Unicode/special characters
- [ ] Variable name can be Unicode/special characters
- [ ] Very long preset/variable names display with ellipsis or wrap
- [ ] HTML special characters in names are escaped (no XSS)
- [ ] Can handle 50+ presets in dropdown
- [ ] Can handle 50+ variables in a preset
- [ ] Can handle 50+ World Info conditions

### Error Handling
- [ ] Missing preset gracefully falls back (no crash)
- [ ] Missing variable doesn't break list rendering
- [ ] Invalid trigger values don't crash
- [ ] Modal can be opened/closed rapidly
- [ ] Modal still works if localStorage is full

## 🚀 Performance

- [ ] Modal opens instantly (no lag)
- [ ] Tab switching is smooth (no visible delay)
- [ ] Adding preset doesn't stall UI
- [ ] Large preset list (50+) still responsive
- [ ] Variable editor opens quickly from modal
- [ ] Scrolling in lists is smooth

## ♿ Accessibility

- [ ] All buttons have title tooltips
- [ ] Focus order is logical (tab key navigation)
- [ ] Colors not only way to distinguish UI elements
- [ ] Icon buttons have text labels or clear visual feedback
- [ ] Modal can be closed with Escape key (if browser allows)

## 🔗 Slash Commands

- [ ] `/state-run` still works (runs prompted updates)
- [ ] `/state-manager` opens manager modal
- [ ] Slash commands have help text
- [ ] Slash commands don't appear to break chat

## 📱 Responsive Design

- [ ] Test on mobile-like screen (narrow width)
- [ ] Test on ultra-wide screen (2560px+)
- [ ] Modal stays visible and functional
- [ ] Tabs stack or scroll if needed
- [ ] Buttons remain clickable and appropriately sized
- [ ] Text remains readable
- [ ] No horizontal scroll needed for normal use

## 🎯 Final Validation

- [ ] Modal loads without console errors
- [ ] No memory leaks (check DevTools if possible)
- [ ] Can use manager multiple times in same session
- [ ] Extension still works after SillyTavern restart
- [ ] All presets/variables persist across restarts
- [ ] Modal styling doesn't interfere with rest of UI
- [ ] Modal is (optional) accessible via keyboard only

---

## 📋 Quick Test Flow

**Recommended order for quick validation:**
1. Open drawer → Click Manager button → Modal appears ✓
2. Presets tab → Create new preset → List updates ✓
3. Variables tab → Select preset → Add variable → See in list ✓
4. Triggers tab → Check "ai" trigger → See in Presets tab description ✓
5. World Info tab → See condition overview ✓
6. Close modal (X or outside click) → Reopen with `/state-manager` ✓
7. Reload SillyTavern → Changes persisted ✓

**Time estimate:** ~5-10 minutes for quick flow, 30-45 minutes for full checklist
