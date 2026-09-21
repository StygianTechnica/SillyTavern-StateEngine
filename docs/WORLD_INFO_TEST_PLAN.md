# State Engine — World Info Conditional Display: QA Test Plan

Document version 1.1 · 2026-09-19 · Extension version 0.14.06 · Target SillyTavern 1.18.x

**Revision 1.1 — gap-resolution pass.** Gaps G1–G15 from version 1.0 are fixed (see §12 for status
and the CHANGELOG). Cases that describe the old behaviour are rewritten to the new expected result and
tagged **FIXED**; new cases for the added behaviour are in §14. Automated suite: **18 files, 1321 tests**.

This plan covers World Info (WI) conditional display and everything built on
it: the condition editor, lorebook → preset bindings, preset export/import,
lorebook bundles, the `window.StateEngineWI` API, and their integration with
SillyTavern (ST). It is written so a QA engineer with no knowledge of the
project can execute it. Section 0 explains the product and sets up all test
data; sections 1–9 are the test cases; sections 10–13 cover regression,
automation, defect reporting and exit criteria.

---------------------------------------------------------------------------

## 0. Read this first

### 0.1 What the feature does (one page)

- **State Engine** keeps *variables* per chat (numbers, strings, booleans,
  enums, arrays, calculated, datetime). Variables live in **presets**; a preset
  is switched on or off per chat.
- **Conditional World Info**: an ST lorebook *entry* can carry *conditions* on
  variables ("`hp` greater than 10"). Before ST scans the lorebook, State Engine
  removes every entry whose conditions are not all true (**AND** logic). An entry
  with no conditions is never touched.
- **Entry key** = `<world>.<uid>` (lorebook name, dot, entry uid), e.g.
  `QA-Book.3`. Conditions are stored under that key. A lorebook with no name
  information is `default`; older data used `unknown` and still works.
- **Fail-open**: when State Engine cannot decide, the entry is **shown**
  (unknown operator, invalid regex, evaluation error, or a condition on a
  variable that no *active* preset defines).
- **Lorebook → preset bindings**: a preset can be bound to a lorebook. When a
  chat with that lorebook opens and the preset is not active, State Engine asks
  "This lorebook ("X") requires the presets A, B. Activate them?". **No** is
  remembered per chat so the question is not repeated.
- **Preset export/import** (JSON file) and **lorebook bundle export/import**
  (lorebook + presets + conditions + bindings in one JSON file).
- **`window.StateEngineWI`** exposes the above to other extensions.

### 0.2 How filtering is hooked in (why it matters for testing)

Filtering runs on ST's `WORLDINFO_ENTRIES_LOADED` event, which fires *before*
each world-info scan with four arrays — `globalLore`, `characterLore`,
`chatLore`, `personaLore` — that State Engine edits in place. Consequences for
testing:

- It runs on **every scan**, including dry runs (token counting), not only on
  generation.
- Conditions are evaluated against the **current** variable values at that
  moment.
- It only affects ST's scan. It does not change the lorebook file.

### 0.3 Test-type legend

| Tag | Meaning |
|---|---|
| **[A]** | Automated test that **already exists** (named in §11). Re-run it; no manual work needed unless the note says so. |
| **[A-new]** | Automated test that **should be written** (listed in §11 backlog). Until it exists, run the manual steps in the Steps column. |
| **[M]** | Manual test in a real ST session. |
| **[M+A]** | Manual test plus an existing automated check of the logic. |

Priority: **P1** blocks release · **P2** should be fixed · **P3** polish.

**FIXED** marks a case that used to describe a known gap; it now verifies the fix.

**KNOWN GAP** marks behaviour verified by reading the code that is *probably
not what a user wants*. The test's expected result states what the code does
today. Run it, record the actual result, and log a defect or an accepted
decision (§12) — do not silently mark it "pass".

### 0.4 Environment

| Item | Requirement |
|---|---|
| SillyTavern | 1.18.x (needs the `WORLDINFO_ENTRIES_LOADED` event). Record exact version. |
| Extension | Installed under `public/scripts/extensions/third-party/SillyTavern-StateEngine`, enabled. |
| Browser | Chrome or Edge (latest) primary; Firefox secondary. Devtools open (F12) on the Console tab. |
| Console prefix | State Engine logs start with `[State Engine]`. Filter the console on that. Enable "Verbose" to see `console.debug` lines such as "filtered out by its conditions". |
| Node (automated) | Node 20+, `npm install` once in the extension folder. |

### 0.5 Useful commands (paste into the browser console)

```js
// Shorthand
const ctx = () => SillyTavern.getContext();
const S   = () => ctx().extensionSettings.state_engine;        // State Engine settings

// Conditions, bindings, declines
S().wiConditions;  S().lorebookPresetBindings;  S().lorebookPresetDeclines;

// Which presets are active in the open chat
S().chatPresetBindings[ctx().chatId];

// Current value of a variable (macro store; name = the variable's full name)
ctx().variables.local.get('se__hp');

// WHAT WILL THE LOREBOOK SCAN SEE?  (dry run: runs the filter, sends nothing)
// Returns the world-info text ST would inject. If this throws in your ST
// version, use ST's "Prompt Itemization" (message menu -> Prompt) instead.
await ctx().getWorldInfoPrompt(ctx().chat.map(m => m.mes).reverse(), 8192, true);
```

Run automated tests: `npm run test:run` (once) or `npm test` (watch), in the
extension folder. Expected today: **18 files, 1321 tests, 0 failures**.

### 0.6 Test data (create once, reuse everywhere)

**Lorebook `QA-Book`** (ST → World Info → New). Create entries, set each to
**Constant (🔵)** so they always try to activate regardless of keywords, and put
its uid in the content so it is visible in the output:

| uid | Content | Used for |
|---|---|---|
| 0 | `ENTRY-0 always` | No conditions (control) |
| 1 | `ENTRY-1 hp>10` | number |
| 2 | `ENTRY-2 mood=happy` | string |
| 3 | `ENTRY-3 alive` | boolean |
| 4 | `ENTRY-4 stance=fight` | enum |
| 5 | `ENTRY-5 has sword` | array contains |
| 6 | `ENTRY-6 two conditions` | AND |
| 7 | `ENTRY-7 regex` | regex |
| 8 | `ENTRY-8 tag enum` | array of enum |
| 9 | `ENTRY-9 spare` | edits / deletion |

**Lorebook `QA-Book-B`**: 3 entries, uid 0–2, Constant — used for multi-lorebook
and world-name tests. **Lorebook `Other`**: 1 entry, uid 0.

**Preset `QA-Vars`** (Manager → Presets → New, then Variables tab). Variable
names are shown/stored with the `se__` prefix automatically:

| Variable | Type | Default | Extra |
|---|---|---|---|
| `hp` | number | 20 | |
| `mood` | string | `happy` | |
| `alive` | boolean | true | |
| `stance` | enum | `fight` | values: `fight`, `flee`, `hide` |
| `inventory` | array, item type *string* | `sword`, `shield` | |
| `tags` | array, item type *enum* | `red` | allowed: `red`, `green`, `blue` |
| `party` | array, item type *object* | empty | |
| `hp_max` | number | 40 | |
| `hp_pct` | calculated | — | expression `se__hp / se__hp_max * 100`, deps `se__hp`, `se__hp_max` |

**Preset `QA-Extra`**: one number variable `gold` = 5. **Preset `QA-Empty`**: no
variables.

**Chats**: `Chat-A` and `Chat-B` with character **QA-Char-1**; `Chat-C` with
**QA-Char-2**; a **group chat** `Group-1` with QA-Char-1 and QA-Char-2.
Activate `QA-Vars` in `Chat-A` unless a test says otherwise.

**Changing a variable value to drive a test**: Manager → Variables, or the
floating tracker panel (click the value of a static variable to edit), or the
console: `ctx().variables.local.set('se__hp', 5)`.

**Adding a condition to an entry**: open `QA-Book` in the WI editor, open the
entry, use the **State Engine Conditions** box (see §2).

### 0.7 Reset between test groups

1. Console: `S().wiConditions = {}; S().lorebookPresetBindings = {}; S().lorebookPresetDeclines = {};`
2. Reload the page (F5). 3. Re-select the chat.
To reset **everything**, delete the `state_engine` block from ST's
`settings.json` while ST is stopped (back it up first).

---------------------------------------------------------------------------

## 1. World Info Conditional Filtering

### 1.1 Operator evaluation

Setup for all: `QA-Vars` active in `Chat-A`; set the variable, add a
condition to the entry, run the probe (§0.5) and check whether the entry
text appears. "Shown" = entry text present. "Hidden" = absent.
Operators compare **case-insensitively** and trim spaces for text.

| ID | Pri | Type | Variable = value · Condition | Expected |
|---|---|---|---|---|
| WIF-OP-01 | P1 | A-new | `mood`=`Happy` · equals `happy` | Shown (case-insensitive) |
| WIF-OP-02 | P2 | A-new | `mood`=`happy ` (trailing space) · equals `happy` | Shown (trimmed) |
| WIF-OP-03 | P1 | A-new | `mood`=`sad` · equals `happy` | Hidden |
| WIF-OP-04 | P2 | A-new | `hp`=5 · equals `5.0` | Hidden (text compare `5` vs `5.0`) — record as documented behaviour |
| WIF-OP-05 | P1 | A-new | `mood`=`sad` · not_equals `happy` | Shown |
| WIF-OP-06 | P1 | A-new | `mood`=`happy` · not_equals `happy` | Hidden |
| WIF-OP-07 | P1 | A-new | `hp`=11 · greater_than `10` | Shown |
| WIF-OP-08 | P1 | A-new | `hp`=10 · greater_than `10` | Hidden (strict) |
| WIF-OP-09 | P1 | A-new | `hp`=9 · less_than `10` | Shown |
| WIF-OP-10 | P1 | A-new | `hp`=10 · less_than `10` | Hidden |
| WIF-OP-11 | P1 | A-new | `hp`=10 · greater_or_equal `10` | Shown |
| WIF-OP-12 | P1 | A-new | `hp`=10 · less_or_equal `10` | Shown |
| WIF-OP-13 | P1 | A-new | `hp`=-5 · less_than `0` | Shown (negatives) |
| WIF-OP-14 | P2 | A-new | `hp`=0 · greater_than `-1` | Shown |
| WIF-OP-15 | P2 | A-new | `hp`=1.5 · greater_than `1.25` | Shown (decimals) |
| WIF-OP-16 | P2 | A-new | `mood`=`happy` · greater_than `3` (non-numeric variable) | **Hidden** — a non-numeric side makes numeric operators false, not fail-open. Record; decide if acceptable |
| WIF-OP-17 | P2 | A-new | `hp`=10 · greater_than `abc` | Hidden (same reason) |
| WIF-OP-18 | P1 | A-new | `mood`=`very happy today` · contains `happy` | Shown (substring) |
| WIF-OP-19 | P1 | A-new | `mood`=`sad` · not_contains `happy` | Shown |
| WIF-OP-20 | P1 | A-new | `inventory`=[sword, shield] · contains `sword` | Shown (array: whole-item match) |
| WIF-OP-21 | P1 | A-new | `inventory`=[sword, shield] · contains `swo` | Hidden (array match is whole item, not substring) |
| WIF-OP-22 | P2 | A-new | `inventory`=[Sword] · contains `sword` | Shown (case-insensitive) |
| WIF-OP-23 | P1 | A-new | `inventory`=[shield] · not_contains `sword` | Shown |
| WIF-OP-24 | P1 | A-new | `inventory` has 2 items · length_gt `1` | Shown |
| WIF-OP-25 | P1 | A-new | `inventory` has 2 items · length_gt `2` | Hidden |
| WIF-OP-26 | P1 | A-new | `inventory` has 2 items · length_eq `2` | Shown |
| WIF-OP-27 | P2 | A-new | `hp`=5 (not an array) · length_gt `1` | Hidden. **Automated only** — the editor cannot produce this input, so there is nothing to do by hand: the editor only offers *length* for array variables |
| WIF-OP-28 | P1 | A-new | `inventory`=[sword, shield] · index_eq `0:sword` | Shown |
| WIF-OP-29 | P1 | A-new | same · index_eq `1:sword` | Hidden |
| WIF-OP-30 | P2 | A-new | same · index_eq `5:sword` (out of range) | Hidden |
| WIF-OP-31 | P3 | A-new | same · index_eq `5:undefined` | Shown — out-of-range compares the text "undefined". Record as quirk |
| WIF-OP-32 | P2 | A-new | index_eq with a bad index (`-1`, `1.5`, `x`, none) | Hidden in every case. **Automated only** — the editor cannot produce this input, so there is nothing to do by hand: the Index box is a whole-number-only field and is required, so these cannot be entered. Manual check: leave Index empty and click Add condition → "Please enter both an index and a value" |
| WIF-OP-33 | P2 | M+A | Array of **string** `inventory` whose first item is `a:b` (set it in the **variable's current value**, in the tracker/variable panel of the open chat — changing only the preset's default does not change a chat that already started). Condition: **item at index ==**, Index `0`, Value `a:b` (stored as `0:a:b`) | Entry shown. Change item 0 to `c` → hidden. (The operator itself is covered by an automated test.) If it fails, note what the array shows in the tracker and any `[State Engine]` console line |
| WIF-OP-34 | P1 | A-new | `mood`=`happy` · in_list `happy, sad` | Shown |
| WIF-OP-35 | P1 | A-new | `mood`=`angry` · in_list `happy,sad` | Hidden |
| WIF-OP-36 | P2 | A-new | `mood`=`HAPPY` · in_list `happy,sad` | Shown |
| WIF-OP-37 | P2 | A-new | `mood`=`a` · in_list `a b, c` | Hidden (list items are `a b` and `c`) |
| WIF-OP-38 | P1 | A-new | `mood`=`hello world` · regex `^hello` | Shown |
| WIF-OP-39 | P2 | A-new | `mood`=`HELLO` · regex `hello` | Shown (regex is case-insensitive) |
| WIF-OP-40 | P1 | A-new | `alive`=true · is_true | Shown |
| WIF-OP-41 | P1 | A-new | `alive`=false · is_true | Hidden |
| WIF-OP-42 | P1 | A-new | `alive`=false · is_false | Shown |
| WIF-OP-43 | P2 | A-new | `hp`=1 · is_true; `hp`=0 · is_false | Shown; Shown (1 is true, 0 is false) |
| WIF-OP-44 | P3 | A-new | `mood`=`yes` · is_true | Hidden (only true/`"true"`/1) |
| WIF-OP-45 | P3 | A-new | Empty array · is_false; `mood`=`` · is_false | Shown; Shown — JavaScript loose equality treats an empty array/string as false. **Automated only** — the editor cannot produce this input, so there is nothing to do by hand: *is true / is false* are offered for scalar variables only (record as quirk) |
| WIF-OP-46 | P2 | A-new | A stored condition whose operator does not exist (`bogus`) | Shown (fail-open); console warning `Unknown operator: bogus`. **Automated only** — the editor cannot produce this input, so there is nothing to do by hand: the operator is a dropdown, so this can only come from edited data or the API |
| WIF-OP-47 | P2 | A-new | Every operator against the inputs `undefined`, `null`, `NaN`, `''`, `[]`, `{}`, a 10 000-char string | No exception; entry shown or hidden per the rules above. **Automated only** — the editor cannot produce this input, so there is nothing to do by hand: it is a robustness sweep, not a scenario |

### 1.2 Variable types

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| WIF-TY-01 | P1 | M | **Number** `hp`: condition `hp greater_than 10`; set `hp`=20 then 5 | Entry 1 shown at 20, hidden at 5 (re-probe after each change) |
| WIF-TY-02 | P1 | M | **String** `mood` equals `happy`; change to `sad` | Shown → hidden |
| WIF-TY-03 | P1 | M | **Boolean** `alive` is_true; toggle | Shown → hidden |
| WIF-TY-04 | P1 | M | **Enum** `stance` equals `fight`; change to `flee` | Shown → hidden |
| WIF-TY-05 | P1 | M | **Array of string** `inventory` contains `sword`; remove `sword` | Shown → hidden |
| WIF-TY-06 | P1 | M | **Array of enum** `tags` contains `red`; change to `blue` | Shown → hidden; the condition's value is a dropdown of `red/green/blue` |
| WIF-TY-07 | P2 | M | **FIXED.** **Array of object** `party`: open the condition editor and pick it | Operator dropdown shows "Not available for object arrays" (disabled); the value box is **disabled** with the note "Conditions on arrays of objects are not supported yet…"; **Add condition** shows the alert "…not supported yet. Please choose a different variable." and nothing is stored; no console error |
| WIF-TY-08 | P2 | M | **Calculated** variable `hp_pct` (expression `hp / hp_max * 100`). In the condition editor pick `hp_pct`, operator *greater than*, Value `40`. Set `hp`=20, `hp_max`=40, then `hp`=10 | Shown while `hp_pct` is 50, hidden once it is 25 |
| WIF-TY-09 | P2 | M | **Datetime** variable `when` (default `2022-05-11 00:00:00`). Condition: *greater than*, Date `2022-05-11 00:00:00`. The box is labelled **Date** and takes the same form as the variable's default; nothing is typed in seconds | Shown once `when` is later than that date, hidden when it is earlier or equal. A value that is not a date is refused with a message. (Plain seconds are still accepted.) **FIXED (was: the condition had to be typed as a seconds number.)** |
| WIF-TY-10 | P2 | M | Change a variable's type after a condition was set (number → string) | No crash; entry still evaluates (record result) |
| WIF-TY-11 | — | — | *Removed.* The manager has no global scope: variables live in presets and presets are switched on per chat. (Code still reads a variable's scope, but nothing in the UI can make one global.) | Not applicable |
| WIF-TY-12 | P2 | A-new | A stored condition whose `variable` is the variable's **name** (`se__hp`) instead of its id | Still evaluates, and counts as "defined" for fail-open. **Automated only** — the editor cannot produce this input, so there is nothing to do by hand: the editor always stores the id. Now also reads the right variable (before, a name-keyed condition was read as a plain string variable) |

### 1.3 Filtering on `WORLDINFO_ENTRIES_LOADED`

**How to run the manual cases in this section, using only the screen (no console):**
1. Open a chat with QA-Book attached, and switch the `QA-Vars` preset on for that chat.
2. In the World Info editor, open QA-Book entry 1 and, in its *State Engine Conditions* box, click
   **Add condition** → variable `QA-Vars / se__hp`, operator *greater than*, Value `10` → **Add condition**.
3. Set `hp` in the State Engine tracker/variables panel of the open chat.
4. To see what the AI would receive, send a message, then open the message's **⋯ menu → Prompt** (Prompt
   Itemization) and look at the *World Info* section for the text `ENTRY-1 hp>10`.
   (The console command in §0.5 shows the same thing, if you prefer.)


| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| WIF-FL-01 | P1 | A | Entries in all four lists, mixed conditions | Unmet removed from every list; met and unconditioned kept; removal count returned. **[A]** *conditional filtering → removes entries…* |
| WIF-FL-02 | P1 | A | Arrays are edited **in place** (same array object) | Same reference afterwards. **[A]** same test |
| WIF-FL-03 | P1 | A | Entries with no conditions | Untouched, count 0. **[A]** *entries with no conditions are untouched* |
| WIF-FL-04 | P1 | A | Malformed payloads: `undefined`, `null`, `5`, `'x'`, `{}`, list is not an array, list contains `null` | No exception; nothing removed. **[A]** *never throws on odd payloads* |
| WIF-FL-05 | P1 | A | Source check that the handler is registered on `WORLDINFO_ENTRIES_LOADED` and **not** on `WORLD_INFO_ACTIVATED`. **[A]** *the filter is registered on an event that can filter* |
| WIF-FL-06 | P1 | M | End to end: entry 1 (`hp>10`), `hp`=20 → probe shows ENTRY-1; `hp`=5 → probe omits it, **without reloading** | Filter follows live values |
| WIF-FL-07 | P1 | M | Send a real message with `hp`=5 and open ST's Prompt Itemization | ENTRY-1 not in the World Info section; ENTRY-0 is |
| WIF-FL-08 | P1 | M | Same with `hp`=20 | ENTRY-1 present |
| WIF-FL-09 | P2 | M | Console shows `[State Engine] World info entry QA-Book.1 filtered out…` (Verbose) when hidden; nothing when shown | As stated |
| WIF-FL-10 | P2 | M | Lorebook **file** unchanged after filtering (open QA-Book in WI editor: all 10 entries and their enabled state intact) | Unchanged |
| WIF-FL-11 | P2 | M | Filtering applies to **global** lorebook, **character** lorebook, **chat** lorebook and **persona** lorebook (attach `QA-Book` each way in turn) | Same result in all four |
| WIF-FL-12 | P2 | M | ST older than 1.18 (no `WORLDINFO_ENTRIES_LOADED`) | Console warning "conditional world info is inactive"; nothing hidden; no crash |
| WIF-FL-13 | P3 | M | Entry that ST itself would not activate (no keyword match, not constant) | Still not activated; filter neither activates nor errors |
| WIF-FL-14 | P2 | M+A | **FIXED.** Handler meets a malformed condition list (set `S().wiConditions['QA-Book.1'] = 'corrupt'`; also try a number, an object, `true`) | **Only that entry** is skipped: it stays visible, a warning naming it is logged, and every other entry is still filtered as normal. **[A]** gap-fixes §2 |
| WIF-FL-15 | P1 | M | Bind preset `QA-Vars` to `QA-Book` (settings → lorebook presets). Attach `QA-Book` to a character as its **additional** lorebook (Character panel → World Info → Additional Lorebooks), then, with another chat of that character open, use **Start new chat** | You are asked "This lorebook (\"QA-Book\") requires the presets QA-Vars. Activate them?". OK → the preset is active in the new chat. **NEW:** additional character lorebooks were previously not noticed at all (only the primary one) |
| WIF-FL-16 | P1 | M | Same as WIF-FL-15 with QA-Book as the character's **primary** lorebook, and again with QA-Book selected as a **global** lorebook | Same prompt each time. If no prompt appears, copy the `[State Engine]` console lines and report which kind of lorebook it was |

### 1.4 Missing variables (fail-open)

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| WIF-MV-01 | P1 | A | Condition on a variable that **no active preset** defines | Entry shown. **[A]** *fail-open (met)* |
| WIF-MV-02 | P1 | M | Delete the variable used by entry 1's condition | Entry 1 shown (fail-open); no console error loop |
| WIF-MV-03 | P1 | M | Rename the variable (`hp` → `health`) | Entry 1 shown (the condition still names the old variable — record; it is not re-linked) |
| WIF-MV-04 | P2 | M | Condition mixes a missing variable and a real, **unmet** one (2 conditions) | Hidden — the missing one is skipped, the real one still applies |
| WIF-MV-05 | P2 | M | Condition mixes a missing variable and a real, **met** one | Shown |
| WIF-MV-06 | P2 | M | Variable exists in an active preset but has no stored value yet (fresh chat) | Uses the variable's **default**; entry evaluated against it |

### 1.5 Inactive and declined presets

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| WIF-PR-01 | P1 | A | Preset deactivated after a condition was hidden by it. **[A]** *with the preset inactive, its conditions no longer hide anything* |
| WIF-PR-02 | P1 | M | `hp`=5, entry 1 hidden. Deactivate `QA-Vars` in `Chat-A` (Manager → Presets toggle) | Entry 1 now shown |
| WIF-PR-03 | P1 | M | Reactivate `QA-Vars` | Entry 1 hidden again (value still 5) |
| WIF-PR-04 | P1 | M | Bind `QA-Vars` to `QA-Book`; open a chat without it active; answer **No** to the prompt | Chat has no `QA-Vars`; entry 1 **shown** (fail-open); no repeated prompt (see §3) |
| WIF-PR-05 | P2 | M | Answer **Yes** instead | `QA-Vars` active; entry 1 follows `hp` |
| WIF-PR-06 | P2 | M | Two presets, one active and one inactive, conditions on variables from each | Active-preset condition applies; inactive-preset condition is skipped |
| WIF-PR-07 | P2 | M | The same variable **name** exists in two presets, only one active | Only the active preset's value is used |

### 1.6 Multiple conditions

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| WIF-MC-01 | P1 | M | Entry 6: `hp greater_than 10` AND `mood equals happy`. Test all four combinations of true/false | Shown **only** when both true |
| WIF-MC-02 | P2 | M | 10 conditions on one entry, all true; then flip one | Shown; hidden |
| WIF-MC-03 | P2 | M | Two conditions on the **same** variable (`hp > 5` AND `hp < 15`) | Shown for 6–14 only |
| WIF-MC-04 | P2 | M | Contradictory conditions (`hp > 10` AND `hp < 5`) | Always hidden; no error |
| WIF-MC-05 | P2 | M | Conditions on entries in **different** lorebooks are independent | Each evaluated on its own key |
| WIF-MC-06 | P3 | M | Duplicate identical conditions added twice | Both stored; behaves as one |

### 1.7 Regex

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| WIF-RX-01 | P1 | A-new | `regex` `^hel+o$` against `hello` | Shown |
| WIF-RX-02 | P1 | A-new | **Invalid** regex `([` | Entry **shown** (fail-open); console error `Invalid regex in condition` |
| WIF-RX-03 | P2 | A-new | Invalid regex on one condition, second condition unmet | Hidden (the invalid one counts as true, the other still applies) |
| WIF-RX-04 | P2 | A-new | Regex against an **array** variable `[a,b]` | Tested against the text `a,b` |
| WIF-RX-05 | P2 | A-new | Catastrophic regex `(a+)+$` against a 40-char `aaaa…b` string | Records how long the probe takes. **Fail** if the UI freezes >2 s (ReDoS); log a defect |
| WIF-RX-06 | P3 | A-new | Regex with special characters, unicode, `/slashes/` (slashes are literal, no flags syntax) | Treated as literal pattern text |

### 1.8 World names and entry keys

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| WIF-WK-01 | P1 | A | `normalizeWorldName`: world → book → folder → `default`; empty/undefined → `default`. **[A]** *world name normalisation* |
| WIF-WK-02 | P1 | A | Keys built as `W.4`, `B.4`, `default.4` |
| WIF-WK-03 | P1 | A | Legacy: conditions saved under `unknown.9` still apply to entry key `default.9`, and can be edited/deleted through it; the legacy key is removed when emptied |
| WIF-WK-04 | P1 | M | Same uid in two lorebooks (`QA-Book.1`, `QA-Book-B.1`): condition on one | Only that lorebook's entry is affected |
| WIF-WK-05 | P1 | M | Lorebook names with a **space**, **dot**, unicode and emoji (`My Book`, `v1.2 Book`, `Ünïcödé`, `📖`) | Conditions set in the editor match the entry in the scan (check by probe) — **watch the dot case**: the key is split on the *first* dot for bundle/prefix logic |
| WIF-WK-06 | P2 | M | Lorebook **renamed** in ST after conditions were added | **KNOWN GAP (expected):** conditions keep the old key and no longer apply; entry is shown. Record |
| WIF-WK-07 | P2 | M | Two lorebooks whose names share a prefix (`Book`, `Book2`) | A condition on `Book.1` never affects `Book2.1` |
| WIF-WK-08 | P2 | M | World names differing only in **case** (`qa-book` vs `QA-Book`) | Treated as different lorebooks (keys are case-sensitive) |
| WIF-WK-09 | P2 | A | Entries with no `world` in the payload use `default.<uid>`. **[A]** (`default.5` case) |
| WIF-WK-10 | P2 | A | Entry with `book` instead of `world` uses the book name. **[A]** (`Other.4` case) |
| WIF-WK-11 | P2 | A-new | Entry with **no uid** (`{world:'W'}`) | Key `W.undefined`; no crash; entry kept unless a condition exists under that literal key |
| WIF-WK-12 | P3 | A-new | uid as number vs string (`4` vs `'4'`) | Same key |

---------------------------------------------------------------------------

## 2. World Info Editor Injection

The condition editor is injected into ST's own World Info entry editor. It is
found by CSS selectors on ST's DOM, so it is the most fragile part; test it on
every ST update.

Where it appears: **World Info panel → pick lorebook → open an entry** → a box
titled **State Engine Conditions** with an **Add condition** button.

### 2.1 Injection timing

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| WIE-IN-01 | P1 | M | Open ST → World Info → select `QA-Book` → expand entry 1 | The **State Engine Conditions** box appears in the entry within ~1 s; exactly **one** box per open entry form |
| WIE-IN-02 | P1 | M | Collapse and re-expand the entry; switch to entry 2 and back | No duplicate boxes; the condition list re-renders for the right entry |
| WIE-IN-03 | P1 | M | Switch lorebook `QA-Book` → `QA-Book-B` → `QA-Book` | Box present each time, showing that entry's conditions |
| WIE-IN-04 | P2 | M | Close the World Info panel, reopen it | Box present again |
| WIE-IN-05 | P2 | M | Reload the page with the WI panel already open | Box appears after load |
| WIE-IN-06 | P2 | M | Create a **new** entry in the WI editor | Box appears; "No conditions — entry will always display." |
| WIE-IN-07 | P2 | M | Open the editor with the extension **disabled** in ST's Extensions list | No box (extension not loaded) |
| WIE-IN-08 | P3 | M | Performance: open a lorebook with 200 entries and expand/collapse quickly | UI stays responsive (the injector runs on every DOM change; note any lag — see §9) |
| WIE-IN-09 | P2 | M | Inspect: box has class `se-wi-injected-conditions`; ids `se_wi_injected_conditions_list`, `se_wi_injected_condition_editor` exist once | As stated |
| WIE-IN-10 | P2 | M | With **two** entry forms expanded at once | **KNOWN GAP (probable):** only the first matching form is injected/queried by `document.querySelector`; record which entry the box edits (see WIE-EK-03) |

### 2.2 Variable dropdown

Click **Add condition** → the editor opens.

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| WIE-VD-01 | P1 | M | Chat with `QA-Vars` active | Dropdown lists `-- Select variable --` plus each variable as `QA-Vars / <name>` |
| WIE-VD-02 | P1 | M+A | **FIXED.** Look at the text of each option | Each option reads `<preset name> / <variable name>` (e.g. `QA-Vars / se__hp`), never a long id. The stored condition still holds the variable id, so existing conditions keep working. A variable with no name shows its label, then its id. **[A]** gap-fixes §5 |
| WIE-VD-03 | P1 | M | Chat with **no** preset active | Only `-- Select variable --` |
| WIE-VD-04 | P2 | M | Two active presets | Variables from both, each prefixed with its preset name; a name used twice appears once (first preset wins) |
| WIE-VD-05 | P2 | M | Activate/deactivate a preset while the WI panel is open, then click Add condition again | List refreshes on each click |
| WIE-VD-06 | P2 | M | No chat open (main menu) | Dropdown empty; no console error |
| WIE-VD-07 | P3 | M+A | **FIXED.** Preset or variable name containing `<`, quotes or `&` | Dropdown text renders literally; no HTML is interpreted. **[A]** gap-fixes §3 |

### 2.3 Operator dropdown and value field

Select a variable, then check the operator list and the value control.

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| WIE-OD-01 | P1 | M | No variable selected | 12 operators: equals, not equals, greater than, less than, ≥, ≤, contains, not contains, in list, regex pattern, is true, is false |
| WIE-OD-02 | P1 | M | Number / string / boolean / enum variable | Same 12 operators |
| WIE-OD-03 | P1 | M | **Array of string** variable | 5 operators: contains, not contains, length >, length ==, item at index == |
| WIE-OD-04 | P1 | M | **Array of enum** variable | Same 5 |
| WIE-OD-05 | P1 | M | **Array of any** variable | 4 operators — **no** index operator |
| WIE-OD-06 | P2 | M | **FIXED.** **Array of object** variable | No operators are offered (dropdown shows "Not available for object arrays", disabled), so `contains`, `index_eq` and the length operators cannot be chosen |
| WIE-OD-07 | P1 | M | Switch variable from array back to number | Operator list returns to the 12 |
| WIE-VF-01 | P1 | M | `equals`, `contains`, etc. | Single text box; placeholder "comma-separated for 'in list'" |
| WIE-VF-02 | P1 | M | `is true` / `is false` | Value box **hidden** |
| WIE-VF-03 | P1 | M | Switch from `is true` back to `equals` | Value box visible again |
| WIE-VF-04 | P1 | M | **Array of enum** variable | Value becomes a **dropdown** of that variable's allowed values (`red/green/blue`) |
| WIE-VF-05 | P2 | M | Array-of-enum variable whose value list contains `"`, `<` or `&` | Options display correctly (escaped) |
| WIE-VF-06 | P2 | M | **FIXED.** **Array of object** variable | Value box is disabled and explains why (see WIF-TY-07); Save is refused with an alert; no exception |
| WIE-VF-07 | P2 | M | Change variable while a value is typed | The value box is rebuilt empty (typed value lost) — expected |
| WIE-VF-08 | P3 | M | Very long value (5 000 chars) | Accepted; list stays readable (wraps) |

### 2.4 Index field (`index_eq`)

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| WIE-IX-01 | P1 | M | Choose an array-of-string variable → `item at index ==` | **Index** number box appears (min 0, step 1) plus the Value box |
| WIE-IX-02 | P1 | M | Switch to any other operator | Index box hidden |
| WIE-IX-03 | P1 | M | Index `0`, value `sword`, Save | Stored value `0:sword`; list shows `<variable> index_eq 0:sword` |
| WIE-IX-04 | P1 | M | Index empty, value `sword`, Save | Alert "Please enter both an index and a value"; nothing stored |
| WIE-IX-05 | P1 | M | Index `0`, value empty, Save | Same alert |
| WIE-IX-06 | P2 | M | Index `-1` or `1.5` typed | Browser may block/allow; if saved, the condition never matches (see WIF-OP-32). Record |
| WIE-IX-07 | P2 | M | Value containing `:` (`a:b`), index `0` | Stored `0:a:b`; matches an item `a:b` |

### 2.5 Add / edit / delete / render

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| WIE-AD-01 | P1 | M | Add condition `hp greater_than 10` to entry 1 → **Add condition** (the green save button) | Condition appears in the list; editor closes; `S().wiConditions['QA-Book.1']` has 1 item |
| WIE-AD-02 | P1 | M | Reload the page, reopen entry 1 | Condition still listed (persisted) |
| WIE-AD-03 | P1 | M | Add a second condition | List shows both; stored in order |
| WIE-AD-04 | P1 | M | Click **Cancel** | Editor closes; nothing stored |
| WIE-AD-05 | P1 | M | Save with no variable selected | Alert "Please select a variable and operator" |
| WIE-AD-06 | P1 | M | Save `equals` with an empty value | Alert "Please enter a value" |
| WIE-AD-07 | P1 | M | Save `is true` with no value | Accepted; stored value is `""` |
| WIE-AD-08 | P2 | M | Value `0` for `greater_than` | **Check:** `0` is a non-empty string so it is accepted; verify it is stored (`"0"`) |
| WIE-AD-09 | P2 | M | Value with only spaces | Accepted or rejected? Record (spaces are non-empty text) |
| WIE-AD-10 | P2 | M | Open the editor, close the WI entry without saving, reopen | Editor closed/reset; no half-saved condition |
| WIE-AD-11 | P2 | M | Add the same condition twice quickly (double-click Save) | Record whether 1 or 2 stored; a duplicate is acceptable, a crash is not |
| WIE-DL-01 | P1 | M | Click the trash icon on a condition | Confirmation "Delete this condition?" |
| WIE-DL-02 | P1 | M | Confirm | Condition removed from list and from settings; if it was the last, list says "No conditions — entry will always display." and the key is gone from `S().wiConditions` |
| WIE-DL-03 | P1 | M | Cancel the confirmation | Nothing removed |
| WIE-DL-04 | P1 | M | With three conditions delete the **middle** one | Correct one removed; the others keep order |
| WIE-DL-05 | P2 | M | Delete, reload | Stays deleted (persisted) |
| WIE-ED-01 | P1 | M | **FIXED.** Each condition row has an **Edit** (pencil) button beside Delete | Click it: the editor opens with that condition's variable, operator and value filled in (an `index_eq` value shows its index and value separately); the save button reads **Save changes**. Change something and save: the **same** condition is replaced (same position, same count) and persisted. **Cancel** leaves it unchanged. See §14 for more |
| WIE-ED-02 | P2 | M | Edit via API: `StateEngineWI.setWICondition` then reopen entry | Shows the new list (see §7) |
| WIE-RD-01 | P1 | M | Entry with existing conditions, open it | Each condition shown as `variable operator value` |
| WIE-RD-02 | P1 | M | Entry with none | "No conditions — entry will always display." |
| WIE-RD-03 | P2 | M | Switch between an entry with and without conditions | List updates each time; no leftover items |
| WIE-RD-04 | P2 | M+A | **FIXED.** Add a condition with value `<b>bold</b><img src=x onerror=alert(1)>` | The list shows the text literally (angle brackets visible); no bold text, no image, **no alert**. The same holds for variable names, operator names and entry keys. **[A]** gap-fixes §3 |
| WIE-RD-05 | P2 | M | Condition value with `&`, quotes, `<` | Compare list display to WIE-MM-02 |
| WIE-RD-06 | P2 | M | 50 conditions on one entry | All listed; scroll works; no lag |

### 2.6 When the entry key cannot be determined

The key comes from a uid element (`[name="uid"]`, `[data-uid]`,
`.world-info-entry-uid`) and a lorebook name (an element, else the selected
option of ST's book dropdown `#world_editor_select`).

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| WIE-EK-01 | P1 | M | Add a condition when ST's DOM offers no uid (simulate in console: temporarily remove the uid element, or test on an ST build whose entry markup changed) | Alert "Could not identify the entry being edited…"; nothing stored |
| WIE-EK-02 | P1 | M | With a normal entry: create a condition, then check `S().wiConditions` | Key is `QA-Book.<uid>` (the **lorebook name**, not `unknown`/`default`) — this is what makes the filter match |
| WIE-EK-03 | P1 | M | **Round trip:** add a condition in the editor, then run the probe | Entry is filtered as expected. **If the entry is never filtered, the editor's key does not match the scan's key: P1 defect** (compare `Object.keys(S().wiConditions)` with the entry's `world`/`uid`) |
| WIE-EK-04 | P2 | M | Lorebook name in the dropdown differs from the file name (e.g. trailing space) | Record any mismatch |
| WIE-EK-05 | P2 | M | Legacy: entry whose old conditions are under `unknown.<uid>` | Still listed and deletable from the editor when the editor resolves to `default.<uid>` |

### 2.7 Manager-modal "World Info" tab (read-only summary)

Manager (sliders icon) → **World Info** tab.

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| WIE-MM-01 | P2 | M | With conditions set | One row per entry key, conditions joined by ` AND `; header shows total entry count |
| WIE-MM-02 | P2 | M | Condition value `<b>x</b>` | Shown as literal text (escaped) |
| WIE-MM-03 | P2 | M | More than 50 entries with conditions | Only the first 50 rows shown (header still shows the total). Record |
| WIE-MM-04 | P2 | M | No conditions | "No World Info conditions set yet." |
| WIE-MM-05 | P2 | M | Tab is read-only | No edit/delete controls (edits happen in the WI editor) |
| WIE-MM-06 | P3 | M | The older condition panel in `wi-manager-ui.js` (ids `se_wi_editor_section`, `se_wi_manage_conditions`) | **KNOWN GAP (probable dead code):** those elements are not in `settings.html`. Confirm they never appear in the UI |

---------------------------------------------------------------------------

## 3. Lorebook Preset Bindings

UI: **Extensions → State Engine → Lorebook Preset Bindings** (bottom of the
State Engine settings drawer).

### 3.1 Bind / unbind

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| LPB-BD-01 | P1 | M | Open the section | Dropdown lists every lorebook in ST plus any with bindings/conditions; preset list shows all presets, unticked |
| LPB-BD-02 | P1 | M | Choose `QA-Book`, tick `QA-Vars`, click **Bind** | Status "Bound 1 preset(s) to "QA-Book""; `QA-Vars` now shows **(bound)** |
| LPB-BD-03 | P1 | M | Tick two presets, **Bind** | Both bound; status says 2 |
| LPB-BD-04 | P1 | M | Bind an already-bound preset | Status counts it, no duplicate in `S().lorebookPresetBindings['QA-Book']['QA-Book']` |
| LPB-BD-05 | P1 | M | Tick a bound preset, **Unbind** | "(bound)" badge gone; removed from settings; when the last one is removed the lorebook key disappears |
| LPB-BD-06 | P1 | M | Unbind a preset that is not bound | Status "Unbound 0 preset(s)…" |
| LPB-BD-07 | P1 | M | Click **Bind** with nothing ticked | Status error "Select a lorebook and tick at least one preset…" |
| LPB-BD-08 | P1 | M | Click **Bind** with no lorebook selected (empty list "No lorebooks found") | Same error |
| LPB-BD-09 | P2 | M | Switch lorebook in the dropdown | The badges update to that lorebook's bindings; ticks reset |
| LPB-BD-10 | P2 | M | Refresh button after creating a new lorebook in ST | New lorebook appears |
| LPB-BD-11 | P2 | M | No presets exist | "No presets yet." |
| LPB-BD-12 | P2 | M | Preset names with HTML characters | Rendered escaped in the list |
| LPB-BD-13 | P1 | A | Bind/unbind/get with shape `{world:{lorebookId:[presetId]}}`, empty containers removed, copy returned. **[A]** *lorebook → preset bindings* |
| LPB-BD-14 | P1 | A | Unknown preset id refused (returns false); `lorebookId` defaults to the world. **[A]** |
| LPB-BD-15 | P2 | A | Lists lorebooks from ST plus the ones State Engine knows; finds chat/character/group-member lorebooks. **[A]** |

### 3.2 Persistence

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| LPB-PS-01 | P1 | M | Bind, reload the page | Binding still shown |
| LPB-PS-02 | P1 | M | Bind, restart the ST server, reload | Binding still there (ST saved `settings.json`) |
| LPB-PS-03 | P1 | A | Bind and unbind trigger a settings save; reads and no-ops do not. **[A]** |
| LPB-PS-04 | P2 | M | Bind in one browser tab, open a second tab | Second tab shows it after reload (same server settings) |

### 3.3 Activation prompt

The prompt appears on **chat change** for each lorebook attached to the chat
that has bound presets not yet active.

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| LPB-AP-01 | P1 | M+A | Bind `QA-Vars` to `QA-Book`; attach `QA-Book` to `QA-Char-1` (character lorebook); open a chat where `QA-Vars` is inactive | Prompt: **This lorebook ("QA-Book") requires the presets QA-Vars. Activate them?** **[A]** message text |
| LPB-AP-02 | P1 | M | **OK** | `QA-Vars` active in that chat; its variables appear in the tracker; the entry conditions now apply |
| LPB-AP-03 | P1 | M | **Cancel** | Not activated; entry conditions on its variables are fail-open (entries shown) |
| LPB-AP-04 | P1 | M | After Cancel, switch to another chat and back | **No** second prompt for that chat |
| LPB-AP-05 | P1 | M | After Cancel, open a **different** chat with the same lorebook | Prompt appears for that chat (decline is per chat) |
| LPB-AP-06 | P1 | M | Preset already active | No prompt |
| LPB-AP-07 | P1 | M | Lorebook has bound presets A (active) and B (inactive) | Prompt names **only B** |
| LPB-AP-08 | P1 | M | Lorebook attached as **chat** lorebook, **global** lorebook, and (group) member lorebook, one at a time | Prompt in each case. Persona lorebook: **KNOWN GAP** — persona lore is not looked at, so **no** prompt; record |
| LPB-AP-09 | P1 | M | Lorebook with **no** bindings | No prompt |
| LPB-AP-10 | P2 | M | New chat (not yet saved) with a bound lorebook | Prompt appears once on chat load; note whether it appears before the character greeting |
| LPB-AP-11 | P2 | M | Deactivate the preset manually after a Yes, reload the chat | Prompt appears again (it was active-then-removed; only **declines** are remembered) |
| LPB-AP-12 | P2 | M | Prompt is a blocking browser dialog: answer it while ST is mid-generation | ST continues normally afterwards; no duplicate prompts |
| LPB-AP-13 | P2 | M | Prompt in a browser that suppresses dialogs ("Prevent this page from creating additional dialogs") | Treated as No; no crash; record |
| LPB-AP-14 | P1 | A | Yes activates; No remembers per chat; already-active skipped; unbound/no-chat no prompt; never throws. **[A]** *auto-activating bound presets…* |

### 3.4 Multiple presets and multiple lorebooks

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| LPB-MP-01 | P1 | M | Bind `QA-Vars` and `QA-Extra` to `QA-Book`; open chat with neither | One prompt naming both presets, in bound order |
| LPB-MP-02 | P1 | M | **OK** | Both active; load order = bound order; variables of both seeded (check tracker) |
| LPB-MP-03 | P1 | M | Chat with **two** lorebooks (`QA-Book` character + `QA-Book-B` chat), each bound to different presets | **Two** prompts, one per lorebook |
| LPB-MP-04 | P1 | M | Cancel the first, OK the second | First's presets inactive and remembered; second's active. Reload: no prompts |
| LPB-MP-05 | P1 | M | Cancel **both** | `S().lorebookPresetDeclines['<chatId>']` holds entries for both (none lost) — **[A]** *one lorebook's No does not lose the other's* |
| LPB-MP-06 | P2 | M | The **same** preset bound to two lorebooks in one chat | First prompt OK → second lorebook no longer asks (preset already active) |
| LPB-MP-07 | P2 | M | Group chat with two characters, each with a different lorebook | Each lorebook that has bindings prompts |

### 3.5 Decline memory

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| LPB-DM-01 | P1 | M | Decline; inspect `S().lorebookPresetDeclines` | `{"<chatId>":["QA-Book|QA-Book|<presetId>"]}` |
| LPB-DM-02 | P1 | M | Reload ST | Decline persists; still no prompt |
| LPB-DM-03 | P2 | M+A | **FIXED.** Decline a prompt, then **unbind and re-bind** (or bind another preset to) that lorebook, reopen the chat | The prompt appears again: any change to a lorebook's bindings clears that lorebook's declines (in every chat). **[A]** gap-fixes §7 |
| LPB-DM-04 | P2 | M+A | **FIXED (partly).** Remove the lorebook from the chat (unassign the character/chat/global lorebook), reopen the chat | That lorebook's declines are removed automatically the next time the chat loads; re-attaching it asks again. Declines of a **deleted chat** still linger until **Clear Declines** (harmless) |
| LPB-DM-05 | P2 | M | Bind a **new** preset to the same lorebook after declining another | Prompt appears, naming only the new preset |
| LPB-DM-06 | P2 | M | Chat ids with special characters | Decline still keyed and honored |

### 3.6 Removal and dangling references

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| LPB-RM-01 | P1 | M | Delete a preset that is bound to `QA-Book` | Preset no longer listed for the lorebook; **no prompt** mentions it; no console error. Raw binding id may remain in settings (skipped on read) — **[A]** *skips deleted presets* |
| LPB-RM-02 | P1 | M | Delete **all** bound presets | No prompts; bindings section shows no "(bound)" |
| LPB-RM-03 | P1 | M | Delete a lorebook in ST that has bindings | Bindings stay in settings (harmless); the lorebook name **still appears** in State Engine's dropdown (it lists bound names). Chats no longer attach it → no prompts. Record |
| LPB-RM-04 | P2 | M | Recreate a lorebook with the same name | Bindings apply again |
| LPB-RM-05 | P2 | M | Rename a lorebook in ST | **KNOWN GAP (expected):** binding stays under the old name and no longer matches; user must re-bind. Record |
| LPB-RM-06 | P2 | A-new | `S().lorebookPresetBindings = {Book:{Book:['ghost']}}` (missing preset) → `getPresetsForLorebook`, `offerLorebookPresets` | Empty list; no prompt; no throw |
| LPB-RM-07 | P2 | A-new | Binding value not an array (`{Book:{Book:'x'}}`), or lorebook entry not an object | Treated as no bindings; no throw |
| LPB-RM-08 | P2 | M | Preset **renamed** | Binding follows (bound by id); prompt shows the new name |

---------------------------------------------------------------------------

## 4. Preset Export and Import

UI: **Manager → Presets tab**. Each preset row has an **Export** (file-export
icon); the tab header has **Import**. Files are `.json`.

### 4.1 Export

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| PEX-EX-01 | P1 | M | Click Export on `QA-Vars` | Browser downloads `QA-Vars.preset.json` (pretty-printed JSON); status "Exported preset "QA-Vars"" |
| PEX-EX-02 | P1 | M | Open the file | Contains `id`, `name`, `namespace`, `description`, `triggers`, `variables` (all 9 with full definitions) |
| PEX-EX-03 | P1 | M | Export a preset with no variables | Valid JSON with `"variables": {}` |
| PEX-EX-04 | P2 | M | Preset name with characters illegal in file names (`a/b:c*`) | Browser sanitises; download still occurs |
| PEX-EX-05 | P1 | A | `exportPreset` returns a deep copy (editing it does not change the stored preset); null for unknown id. **[A]** |
| PEX-EX-06 | P2 | M | Export does not change anything (compare `S().presets` before/after) | Identical |
| PEX-EX-07 | P3 | M | Export a preset with 500 variables | Completes <2 s; file valid |

### 4.2 Import

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| PEX-IM-01 | P1 | M | Import the file exported in PEX-EX-01 | New preset appears, named **`QA-Vars (imported)`**; original untouched; status "Imported preset…" |
| PEX-IM-02 | P1 | M | Import it again | Second copy named **`QA-Vars (imported 2)`** |
| PEX-IM-03 | P1 | M | Cancel the file picker | Nothing happens, no error |
| PEX-IM-04 | P1 | M | Choose a non-JSON file (`.txt` renamed `.json`) | Alert "…is not valid JSON." |
| PEX-IM-05 | P1 | M | JSON that is not a preset (`{"a":1}`, `[]`, `"text"`, `null`) | Alert "That file is not a State Engine preset…"; nothing added |
| PEX-IM-06 | P2 | M | A wrapped file `{"preset":{…}}` | Accepted (the `preset` property is used) |
| PEX-IM-07 | P1 | M | Import a preset, then activate it in `Chat-B` | Variables seeded with their defaults; tracker shows them; macros `{{getvar::…}}` work |
| PEX-IM-08 | P1 | A | New id, keeps description/triggers, saves settings, original untouched. **[A]** *preset export / import* |
| PEX-IM-09 | P1 | A | Rejects null/undefined/number/string/array/`{}`/`{variables:[]}`/`{variables:'no'}`; does not mutate its input. **[A]** |
| PEX-IM-10 | P2 | M | Import a file exported from a **different** install/ST | Works; unknown namespace moved to the built-in `se` namespace (see 4.5) |
| PEX-IM-11 | P2 | M | Import a 5 MB file | Records time; UI stays responsive |

### 4.3 Unique ids and names

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| PEX-UN-01 | P1 | M+A | After import, compare ids: preset id and every variable id differ from the original's | All new. **[A]** *imported variables get fresh ids…* |
| PEX-UN-02 | P1 | M+A | Variable names across **all** presets are unique after importing a copy | Copy's variables are `se__hp_2`, `se__mood_2`, … |
| PEX-UN-03 | P1 | A | Free name keeps its name (`se__fresh`). **[A]** |
| PEX-UN-04 | P2 | M | Import three copies in a row | Suffixes `_2`, `_3`, `_4`; no collisions |
| PEX-UN-05 | P2 | A-new | A variable named `se__hp_2` already exists, then import a preset with `se__hp` | New name skips to `se__hp_3` |
| PEX-UN-06 | P2 | A-new | Two variables inside the imported file with the **same** name | Second gets a suffix (unique within the import) |
| PEX-UN-07 | P2 | M | Two presets with the same display name (`QA-Vars`) in the **same namespace** | Never created: the import renames |
| PEX-UN-08 | P3 | M | Preset name that already ends in `(imported)` | Suffix appended again (`… (imported) (imported)`); acceptable |

### 4.4 Calculated variables, enums, array item types

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| PEX-CV-01 | P1 | A | Import a preset whose `hp_pct` depends on `hp`, `hp_max` and the copy renames them | The copy's `dependencies` and `expression` use the **new** names (`se__hp_2 / se__hp_max_2 * 100`); word-boundary safe (`hp` does not touch `hp_max`). **[A]** |
| PEX-CV-02 | P1 | M | Activate the imported preset; change `se__hp_2` | `hp_pct` copy recalculates (calculated variables evaluate through the real engine); no "Evaluation failed" badge |
| PEX-CV-03 | P2 | M | Calculated variable depending on a variable **not** in the same preset | After import it still points at that (unrenamed) variable; record whether it evaluates |
| PEX-CV-04 | P2 | A-new | Expression referencing a name that is a substring of another (`hp` and `hp_max`), plus string literals containing the text `hp` | Only identifiers are rewritten; **check string literals** — the rewrite is a text rewrite, so a literal like `"hp"` inside an expression may be altered. Record actual |
| PEX-CV-05 | P2 | M | Calculated variable chain (A → B → C) | All rewired |
| PEX-EN-01 | P1 | M | Import `stance` (enum with 3 values) | Same enum values and default in the copy; editor shows them |
| PEX-EN-02 | P2 | M | Enum with duplicate or empty values in the file | Imported as-is (no validation); record |
| PEX-AR-01 | P1 | M | Import `inventory` (array, item type string, default 2 items) | Defaults, item type, `unique`/`sorted`/`maxLength` settings preserved |
| PEX-AR-02 | P1 | M | Import `tags` (array of enum with `itemEnumValues`) | Allowed values preserved; editor dropdown lists them |
| PEX-AR-03 | P2 | M | Import `party` (array of object) | Imported; item type object preserved |
| PEX-AR-04 | P2 | A-new | Deep copy: changing the imported variable's `itemEnumValues` does not change the original's | Independent arrays |

### 4.5 Duplicates, conflicts and bad data

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| PEX-CF-01 | P1 | M | Import a preset whose **name** equals an existing preset | Renamed `(imported)`; both exist |
| PEX-CF-02 | P1 | M | Import a preset whose **variable names** equal existing ones | Variables renamed `_2`; existing untouched; **no** duplicate names anywhere (state stores are keyed by name) |
| PEX-CF-03 | P1 | M | Import the identical preset 3 times, activate all three in one chat | All three coexist with distinct variables; macros for each resolve independently |
| PEX-CF-04 | P2 | A | Unknown namespace (`zz`) imported into `se`; variable prefix `zz__` → `se__`. **[A]** |
| PEX-CF-05 | P2 | A-new | File with a **known** non-`se` namespace | Keeps that namespace and prefix |
| PEX-CF-06 | P2 | A-new | Variable with **no `name`** or a non-string name | **KNOWN GAP (probable):** imported with an empty name. Expected by design: reject or auto-name. Record; log a defect |
| PEX-CF-07 | P2 | A-new | Variable entry that is `null` or a string | Skipped; others imported |
| PEX-CF-08 | P2 | A-new | `triggers` missing / not an array | Defaults to `['ai']` |
| PEX-CF-09 | P3 | A-new | Prototype-pollution attempt in the file: `{"__proto__":{"x":1}}`, `{"variables":{"__proto__":{…}}}` | `Object.prototype` unchanged after import |
| PEX-CF-10 | P2 | M | Import while another import's picker is open | Second picker independent; no interference |

---------------------------------------------------------------------------

## 5. Lorebook Bundle Export and Import

UI: **State Engine settings → Lorebook Preset Bindings → Export bundle /
Import bundle** (acts on the lorebook selected in the dropdown).

Bundle format (must match exactly):

```json
{
  "lorebook": { "entries": { … } },
  "lorebookName": "QA-Book",
  "stateEngine": {
    "presets": { "<presetId>": { … } },
    "wiConditions": { "QA-Book.1": [ { "variable": "…", "operator": "…", "value": "…" } ] },
    "lorebookPresetBindings": { "QA-Book": { "QA-Book": [ "<presetId>" ] } }
  }
}
```

*Setup for this section:* bind `QA-Vars` to `QA-Book`; add conditions to
entries 1, 2 and 6 (two conditions); add one condition to `QA-Book-B` entry 0
and to `Other.0`.

### 5.1 Export

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| LBE-EX-01 | P1 | M | Select `QA-Book` → **Export bundle** | Downloads `QA-Book.stateengine-bundle.json`; status "Exported "QA-Book" with 1 preset(s)." |
| LBE-EX-02 | P1 | M+A | Inspect the file | Has `lorebook`, `lorebookName`, `stateEngine.presets`, `.wiConditions`, `.lorebookPresetBindings` exactly as above. **[A]** *exports the lorebook with its conditions…* |
| LBE-EX-03 | P1 | M+A | `wiConditions` contains **only** keys starting `QA-Book.` (entries 1, 2, 6) — not `QA-Book-B.0` nor `Other.0` (name-prefix collision check). **[A]** incl. `BookTwo` case |
| LBE-EX-04 | P1 | M | Bundle with **two presets** bound | Both under `presets`; both ids under the binding |
| LBE-EX-05 | P1 | M | Entry 6 has two conditions | Both present, in order |
| LBE-EX-06 | P1 | M | **Multiple lorebooks:** export `QA-Book`, then `QA-Book-B` | Two separate files, each self-contained; a bundle never includes another lorebook's conditions |
| LBE-EX-07 | P2 | M+A | Lorebook with **no** bindings and **no** conditions | Valid bundle whose `stateEngine` is an **empty object** — `presets`, `wiConditions` and `lorebookPresetBindings` are **left out**, not written as empty lists. **[A]** gap-fixes §10.5 |
| LBE-EX-08 | P1 | A | Lorebook that cannot be loaded (deleted/missing) → null, warning, no download; UI status "Could not load lorebook" |
| LBE-EX-09 | P2 | M | The `lorebook` block equals ST's own export of that lorebook (compare entries count and content) | Same entries |
| LBE-EX-10 | P2 | M | Bundle contains **no** variable *values* or chat data | Only definitions |
| LBE-EX-11 | P2 | M | Bound preset that was deleted | Not in the bundle; binding lists only existing presets |
| LBE-EX-12 | P2 | A | Bundle is JSON-safe (`JSON.parse(JSON.stringify(b))` equals `b`). **[A]** |
| LBE-EX-13 | P2 | M | Very large lorebook (1 000 entries) | Export completes; file valid; record time |

### 5.2 Import — happy paths

Use a **clean second profile** (or reset per §0.7) unless stated.

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| LBE-IM-01 | P1 | M | Import the `QA-Book` bundle on a clean install | Lorebook `QA-Book` appears in ST's World Info list with all entries; status "Imported "QA-Book": 1 preset(s), 3 condition(s)." |
| LBE-IM-02 | P1 | M+A | Presets imported | Preset `QA-Vars` exists with all variables. **[A]** |
| LBE-IM-03 | P1 | M+A | Conditions merged and **re-pointed** at the imported variables' ids | Each condition's `variable` is the *new* variable id; open entry 1 in the WI editor: the condition is listed; probe filters correctly. **[A]** |
| LBE-IM-04 | P1 | M+A | Bindings merged: `QA-Book → QA-Book → [<new preset id>]` | As stated. **[A]** |
| LBE-IM-05 | P1 | M | Prompt "The lorebook "QA-Book" comes with the presets QA-Vars. Activate them for this chat?" | OK activates in the open chat; Cancel does not (and no decline is recorded) |
| LBE-IM-06 | P1 | M | After OK, run the probe and change `hp` | Entry 1 follows `hp` — the whole chain works after import |
| LBE-IM-07 | P2 | M | Import with no chat open | No activation prompt; everything else imported |
| LBE-IM-08 | P2 | M | Import a bundle with **no** bound presets | Lorebook + conditions imported; no prompt |

### 5.3 Import — merging and duplicates

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| LBE-MG-01 | P1 | M+A | Import the **same bundle twice** | No new preset created (identical preset — same name and variable names — is reused); conditions **not duplicated** (result says 0 new); binding not duplicated. **[A]** |
| LBE-MG-02 | P1 | M | On the *same* install where the preset already exists (bundle exported here) | Overwrite prompt for the lorebook ("already exists… Overwrite?"); OK → reuses existing preset; conditions re-pointed at **existing** variable ids |
| LBE-MG-03 | P1 | M+A | Overwrite prompt **Cancel** | Nothing imported at all (no lorebook, presets, conditions or bindings). **[A]** |
| LBE-MG-04 | P1 | M+A | A **different** preset already owns the variable names | Imported preset's variables renamed `_2`; the imported conditions point at the **renamed** variables. **[A]** |
| LBE-MG-05 | P1 | M | Existing conditions on the same entry keys before import | New conditions appended; existing kept; identical ones skipped |
| LBE-MG-06 | P1 | M | Existing bindings for that lorebook before import | Union of existing and imported preset ids; no duplicates |
| LBE-MG-07 | P2 | M | Bundle imported under a **new name** (`options.name`, via `StateEngineWI.importLorebookBundle(bundle,{name:'X'})`) | Conditions re-keyed `X.<uid>`; binding under `X → X`; lorebook saved as `X` |
| LBE-MG-08 | P2 | M | Same preset, but the user **edited** the existing copy (added a variable) before importing | Not identical → imported as a new preset (renamed); record whether that is the desired outcome |
| LBE-MG-09 | P2 | M | Two different bundles that share a preset name | Two presets (second gets a suffix) |
| LBE-MG-10 | P2 | M | Bundle with **two presets**, only one already installed | One reused, one imported; conditions map to the right ones |

### 5.4 Import — missing, invalid and corrupted data

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| LBE-BAD-01 | P1 | A | Not a bundle (`null`, `{}`, `{lorebook:{}}`, `{lorebook:'x'}`, plain text) | Returns null; warning; **nothing** written. **[A]** *rejects a bundle without a lorebook* |
| LBE-BAD-02 | P1 | A | No name anywhere (`lorebookName` and bindings absent), no `options.name` | Returns null; warning. With `options.name` → imports. **[A]** *needs a name* |
| LBE-BAD-03 | P1 | M | Bundle with `stateEngine` **missing** entirely | Lorebook imported; nothing else; no error |
| LBE-BAD-04 | P1 | M+A | `stateEngine.presets` missing, conditions present | Conditions on variables that **this install does not define** are **dropped** (counted in the result's `skipped.conditions`), not stored dangling; conditions on variables it does define are kept. No crash. **[A]** gap-fixes §10.3 |
| LBE-BAD-05 | P1 | M | `wiConditions` value not an array (`{"QA-Book.1":"x"}`) | That key skipped; others imported |
| LBE-BAD-06 | P2 | A-new | A condition that is `null`, a string, or lacks `variable` | Does not crash the import; record what is stored |
| LBE-BAD-07 | P1 | A-new | A preset in the bundle that is corrupt (`null`, no `variables`) | Skipped; the rest imported |
| LBE-BAD-08 | P1 | M+A | **Bundle references a missing preset:** binding lists an id not in `presets` | No binding is created for it (and no empty binding entry); other bindings imported. **[A]** gap-fixes §10.2 |
| LBE-BAD-09 | P1 | M | **Bundle references a missing lorebook:** `lorebook` present but `lorebookName` refers to nothing else, or bindings name a different lorebook than the file | Imported under `lorebookName`; bindings re-keyed to it |
| LBE-BAD-10 | P2 | M | Bindings mention **several** lorebooks in one bundle (hand-edited) | All mapped presets are bound under the imported lorebook's name (a bundle carries one lorebook); only presets present in the bundle are bound — record |
| LBE-BAD-11 | P2 | A-new | `lorebook.entries` is an array or empty object | Empty `{}` accepted (empty lorebook); array/`null` rejected. Record |
| LBE-BAD-12 | P2 | M | Bundle from a **newer/older** extension (extra/unknown fields) | Unknown fields ignored |
| LBE-BAD-13 | P2 | M | Truncated JSON file | Alert "…is not valid JSON."; nothing imported |
| LBE-BAD-14 | P2 | M | ST's `saveWorldInfo` fails (simulate by making it throw in console) | Error status; **KNOWN GAP (probable):** presets/conditions may already be partly written if the failure comes after the lorebook step; record ordering (lorebook is saved first, so a save failure happens before any State Engine data changes) |
| LBE-BAD-15 | P1 | M | Import a bundle onto a name that exists, choose Cancel, verify the existing lorebook is unchanged | Unchanged |
| LBE-BAD-16 | P3 | A-new | Prototype-pollution keys in the bundle | No global object polluted |

---------------------------------------------------------------------------

## 6. Settings and Persistence

Settings live in ST's `settings.json` under `extensionSettings.state_engine`.

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| SET-PS-01 | P1 | A | Each condition change (add/update/delete/clear) triggers a settings save; no-ops do not. **[A]** *WI conditions persist* |
| SET-PS-02 | P1 | M | Add conditions, stop ST, restart, reload | Conditions present |
| SET-PS-03 | P1 | M | Add bindings, restart | Present |
| SET-PS-04 | P1 | M | Decline a prompt, restart | `lorebookPresetDeclines` retained; no prompt |
| SET-PS-05 | P2 | M | Open ST in a second browser, edit conditions in one, reload the other | Reflects server state |
| SET-PS-06 | P2 | M | Rapid successive changes (10 in 2 s), then kill the browser tab | Debounced save: last state persisted or at most the last <1 s lost. Record |
| SET-MG-01 | P1 | M | **Upgrade test:** take a `settings.json` from the previous extension version (no `lorebookPresetBindings`/`lorebookPresetDeclines`), load | Both fields appear as `{}`; all existing presets, chats, conditions intact; no console error |
| SET-MG-02 | P1 | A | Missing/corrupt (`'junk'`, `[]`) `lorebookPresetBindings` / `lorebookPresetDeclines` are repaired to `{}`. **[A]** |
| SET-MG-03 | P1 | M | Old conditions under `unknown.<uid>` keep working | See WIF-WK-03 |
| SET-MG-04 | P2 | M | Downgrade: load newer settings in the older extension | Unknown keys ignored; no crash (record) |
| SET-CR-01 | P1 | A-new | `wiConditions` is `null`, a string, or an array | Repaired to `{}` on load (existing behavior) |
| SET-CR-02 | P1 | M+A | **FIXED.** `wiConditions['QA-Book.1']` is a string/number/object (not an array) | Treated as "cannot decide": the entry is shown, a warning is logged, and filtering of all other entries is unaffected. **[A]** gap-fixes §2 |
| SET-CR-03 | P2 | A-new | A condition object missing `operator`/`variable` | Operator lookup fails → fail-open (shown) |
| SET-CR-04 | P2 | A-new | `lorebookPresetBindings` contains non-string preset ids, numbers, `null` | Skipped on read |
| SET-CR-05 | P2 | A-new | `lorebookPresetDeclines[chat]` is not an array | **Check:** activation logic spreads it; record behaviour and log a defect if it throws |
| SET-CR-06 | P2 | M | Whole `state_engine` block deleted | Defaults restored; extension loads |
| SET-UK-01 | P2 | M | Add unknown keys (`state_engine.foo = 1`, `wiConditions.foo`) | Preserved on save; ignored by logic |
| SET-UK-02 | P2 | M | Unknown operator in a stored condition | Fail-open (WIF-OP-46) |
| SET-UK-03 | P3 | M | Calendar/preset/variable-store data untouched by any WI action | Diff `S()` (excluding the WI keys) before and after a WI session: no other changes |

---------------------------------------------------------------------------

## 7. API Surface — `window.StateEngineWI`

Run in the browser console. The object is **frozen**; functions listed below
must all exist.

**Every function takes the caller identity first**, exactly like the namespaced
`stateEngine.*` API: `StateEngineWI.fn(extensionId, instanceId, ...args)`. In the
table below the leading `extensionId, instanceId` arguments are written `…me` for
brevity. Get them in the console with:

```js
const me = ['se', SillyTavern.getContext().extensionSettings.state_engine.extensions.se.instanceId];
// e.g.  StateEngineWI.getWIConditions(...me, 'QA-Book.1')
```

(An outside extension registers a namespace first and uses its own id and the
instance id; a call from an extension that owns no namespace is rejected.)

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| API-01 | P1 | A+M | `Object.keys(window.StateEngineWI)` | `getWIConditions, setWICondition, deleteWICondition, shouldDisplayWIEntry, getPresetsForLorebook, bindPresetToLorebook, unbindPresetFromLorebook, exportPreset, importPreset, exportLorebookBundle, importLorebookBundle`. **[A]** *exposes the whole API* |
| API-02 | P1 | M | `Object.isFrozen(window.StateEngineWI)`; try `StateEngineWI.x = 1` | Frozen; assignment ignored |
| API-03 | P1 | M | `StateEngineWI.setWICondition('QA-Book.9',{variable:'x',operator:'equals',value:'1'})` then `getWIConditions('QA-Book.9')` | Returns the array with 1 item; persisted; visible in the WI editor for entry 9 |
| API-04 | P1 | M | `deleteWICondition('QA-Book.9',0)` | Removed; key gone when empty |
| API-05 | P1 | M | `shouldDisplayWIEntry('QA-Book.0')` (no conditions) | `true` |
| API-06 | P1 | M | `shouldDisplayWIEntry('QA-Book.1')` with `hp`=5 and `hp>10` | `false` |
| API-07 | P2 | M+A | **FIXED.** `shouldDisplayWIEntry(...)` for a condition on a **missing** variable, an **unknown operator**, an invalid regex, or a malformed list | `true` in every case — it uses the same rule as the filter, so the two always agree (compare with the probe). Errors are logged, never thrown. **[A]** gap-fixes §9 |
| API-08 | P1 | M | `bindPresetToLorebook('QA-Book','QA-Book', <id>)` → `true`; `getPresetsForLorebook(...)` → `[id]`; `unbind…` → `true` then `false` | As stated |
| API-09 | P1 | M | `bindPresetToLorebook('QA-Book','QA-Book','ghost')` | `false`; console warning; nothing stored |
| API-10 | P1 | M | `exportPreset(id)` → object; `exportPreset('ghost')` → `null` | As stated |
| API-11 | P1 | M | `importPreset(exportPreset(id))` → new id (string); `importPreset({})` → `null` | As stated |
| API-12 | P1 | M | `await exportLorebookBundle('QA-Book')` (one argument) | Bundle (second argument defaults to the first) |
| API-13 | P1 | M | `await exportLorebookBundle('Nope','Nope')` | `null` |
| API-14 | P1 | M | `await importLorebookBundle(bundle)` | Summary `{lorebook, presetIds, boundPresetIds, conditions, activated}` |
| API-15 | P1 | M | `await importLorebookBundle(null)` / `({})` | `null`; no exception |
| API-16 | P2 | M | Error handling: call every function with `undefined`, `null`, numbers, objects | Read functions return `[]`/`null`/`true`; none throws (except a non-async function given input it cannot handle — record any throw) |
| API-17 | P1 | M | **Before a chat loads** (main menu, no chat): call `getWIConditions`, `setWICondition`, `getPresetsForLorebook`, `bindPresetToLorebook` | Work (no chat needed) |
| API-18 | P2 | M | Before a chat loads: `shouldDisplayWIEntry('QA-Book.1')`, `exportLorebookBundle` | Does not throw; unconditional/`null`-safe; record results |
| API-19 | P2 | M | Invalid keys: `getWIConditions('')`, `('nodot')`, `(undefined)`, `(42)` | Returns `[]` (or throws a TypeError for `undefined`/`42` — **record**: expected is `[]`) |
| API-20 | P2 | M | Keys with prototype names: `getWIConditions('constructor')`, `('__proto__.1')` | `[]`; no pollution |
| API-21 | P1 | M+A | **FIXED.** Call any `StateEngineWI` function with a wrong/missing `instanceId`, then with an extension id that owns no namespace | First: throws `State Engine API call rejected: wrong instance`. Second: throws `Extension '<id>' does not own a namespace - call createNamespace() first`. Same errors as `stateEngine.*`; thrown **synchronously** (also for the async functions); nothing is changed by a rejected call. **[A]** gap-fixes §8 |
| API-22 | P2 | M | Object exists after page load and after chat changes (not re-created) | Same object |
| API-23 | P2 | M | Calling `importLorebookBundle` shows the overwrite/activation `confirm()` dialogs | Yes (interactive). For automation, stub `window.confirm` |

---------------------------------------------------------------------------

## 8. Integration with SillyTavern

Use the probe (§0.5) after every action. Precondition for the section:
`QA-Book` attached, conditions on entries 1, 2, 6, `QA-Vars` bound.

### 8.1 Chat, character and group changes

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| INT-CH-01 | P1 | M | `Chat-A` (`hp`=5) → `Chat-B` (`hp`=20, separate store) → back | Filtering reflects **each chat's own** values |
| INT-CH-02 | P1 | M | Switch chat with the tracker panel open | Panel and filter both update; no stale values from the previous chat |
| INT-CH-03 | P1 | M | New chat with the same character | Variables re-seeded per settings (reset-on-new-chat rules); bound-preset prompt appears if needed |
| INT-CH-04 | P1 | M | Character change `QA-Char-1` → `QA-Char-2` (which has no lorebook) | `QA-Book` entries no longer in the scan; no prompt for it |
| INT-CH-05 | P1 | M | Character with the lorebook as its **character** lorebook, and a chat lorebook set to a different book | Both lorebooks prompt/filter independently |
| INT-CH-06 | P1 | M | **Group chat** (`Group-1`): members' lorebooks | Each member lorebook with bindings prompts; filtering applies to entries from all members |
| INT-CH-07 | P2 | M | Group: change speaker order / mute a member | No errors; prompts do not repeat |
| INT-CH-08 | P2 | M | Delete the current chat | No console errors; settings retain stale decline (LPB-DM-04) |
| INT-CH-09 | P2 | M | Import/rename a character | Bindings/conditions unaffected (keyed by lorebook name) |

### 8.2 Lorebook switching

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| INT-LB-01 | P1 | M | Attach `QA-Book`, then swap the chat lorebook to `QA-Book-B` | `QA-Book` filtering stops applying; `QA-Book-B` conditions apply; prompt appears for `QA-Book-B` bindings if unmet |
| INT-LB-02 | P1 | M | Select/deselect `QA-Book` as a **global** lorebook | Prompt (select), filtering on/off |
| INT-LB-03 | P2 | M | Attach the **same** lorebook in two ways (character + global) | ST de-duplicates its entries; State Engine prompts **once** |
| INT-LB-04 | P2 | M | Edit an entry's content in the WI editor | Conditions stay bound to the entry (uid unchanged) |
| INT-LB-05 | P2 | M | Delete an entry in the WI editor, create a new one | New entry gets a new uid; the old entry's conditions remain in settings, unattached (stale). Record |
| INT-LB-06 | P2 | M | Duplicate an entry | Duplicate has **no** conditions (new uid) |
| INT-LB-07 | P2 | M | ST "reorder"/"sort" of entries | uid unchanged; conditions still apply |
| INT-LB-08 | P2 | M | Import a lorebook via ST's own import that reuses uids of a lorebook that had conditions | Conditions apply to the same uid; record |

### 8.3 World info and State Engine on/off

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| INT-ON-01 | P1 | M | Disable ST's **World Info** globally (WI panel toggle / set budget 0) | No world info scanned; no errors from State Engine |
| INT-ON-02 | P1 | M+A | **FIXED.** Turn **Enable State Engine** off (State Engine settings), then run the probe with an unmet condition | **Nothing is filtered** — every entry passes through untouched. Turn it back on: filtering resumes immediately (no reload). The hook stays registered. **[A]** gap-fixes §1 |
| INT-ON-03 | P1 | M | Turn State Engine off, then check variable updates/prompted updates | They stop (existing behavior); confirm only the WI filter is the exception |
| INT-ON-04 | P2 | M | Disable the extension in ST's Extensions manager and reload | No filtering, no editor box, no prompts, `window.StateEngineWI` undefined |
| INT-ON-05 | P2 | M | Re-enable | Everything returns; settings intact |
| INT-ON-06 | P2 | M | Individual entry **disabled** in ST | Still not activated; conditions irrelevant |
| INT-ON-07 | P2 | M | Entry set to "constant"/"vectorized"/"sticky"/"cooldown" | Filter removes it before scan; sticky/cooldown timers unaffected for entries that stay |
| INT-ON-08 | P2 | M | Inclusion groups / recursion / min-activations settings | Removed entries do not take part in group scoring or recursion (they never enter the scan) |

### 8.4 Themes and visuals

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| INT-TH-01 | P2 | M+A | **FIXED.** Switch ST theme (default dark, light, a custom theme) with the WI editor open | The **State Engine Conditions** box, its editor and the condition rows take their colours from SillyTavern's theme (`--SmartThemeBodyColor`, `--black30a`, `--SmartThemeBorderColor`): readable on every theme. Screenshot each theme to confirm |
| INT-TH-02 | P2 | M | Same for the settings drawer's **Lorebook Preset Bindings** section and the manager modal's Presets tab buttons | Readable; icons visible |
| INT-TH-03 | P2 | M | Zoom 50%–200%, mobile width (375 px) | No overlapping/clipped controls; the 3-column condition editor stays usable |
| INT-TH-04 | P3 | M | Keyboard-only use (Tab, Enter, Esc) through Add condition, Save, Delete | All controls reachable and operable; record focus order problems |
| INT-TH-05 | P3 | M | Screen reader labels present for the variable/operator/value fields | Labels associated (`for` ids present) |

### 8.5 ST updates and changing data

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| INT-UP-01 | P1 | M | After every ST update: run WIF-FL-06, WIE-IN-01, WIE-EK-03, LPB-AP-01 as a smoke test | All pass; otherwise the ST DOM/event contract changed |
| INT-UP-02 | P1 | M | ST updates world-info entries during a chat (edit an entry in another tab, save) | Next scan uses the new entry data; conditions keep applying by uid |
| INT-UP-03 | P2 | M | ST auto-updates the extension list | No changes to settings |
| INT-UP-04 | P2 | M | Verify the ST APIs the feature depends on still exist: `SillyTavern.getContext().getWorldInfoNames`, `.loadWorldInfo`, `.saveWorldInfo`, `.updateWorldInfoList`, `.chatMetadata`, `.characters`, `.groups`, event `eventTypes.WORLDINFO_ENTRIES_LOADED` | All defined |
| INT-UP-05 | P2 | M | ST DOM selectors used by the injector still exist: `#world_editor_select`, `#world_info`, `.world_entry[data-uid]` | Present |

---------------------------------------------------------------------------

## 9. Performance and Stress

Record measurements in the results column. **Budgets** (fail if exceeded):
filter pass ≤ 50 ms per 1 000 entries with 1 condition each; WI editor never
freezes >200 ms; page load overhead from the extension ≤ 300 ms.

Measure the filter with: `console.time('f'); await ctx().getWorldInfoPrompt(…dry run…); console.timeEnd('f');`

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| PRF-01 | P1 | A-new | **10 000 entries**, 1 000 with conditions, one variable | Filter pass within budget (scale linearly); result count correct |
| PRF-02 | P2 | A-new | 10 000 entries all with conditions | Record time; no quadratic growth (compare 1k vs 10k) |
| PRF-03 | P2 | A-new | One entry with 500 conditions | Evaluates; short-circuits on the first unmet |
| PRF-04 | P2 | M | **200 presets**, 20 variables each; open Manager and the bindings section | Lists render <1 s; scrolling smooth |
| PRF-05 | P2 | M | 200 presets bound to one lorebook; open a chat | One prompt naming 200 presets (long dialog): record usability; **KNOWN GAP (design):** no cap or shortening of the list |
| PRF-06 | P2 | M | **500 lorebooks** | Dropdown builds <1 s; alphabetical |
| PRF-07 | P2 | M | 50 lorebooks attached at once (global) with bindings on each | 50 sequential prompts — record; expected usability problem; log a defect if it blocks use |
| PRF-08 | P2 | M | 5 000 conditions in `wiConditions` | Settings save time and page load time recorded; Manager World Info tab shows 50 rows |
| PRF-09 | P1 | M | **Rapid chat switching:** switch between 4 chats 30 times in 30 s | No duplicate/stacked prompts; no console errors; memory stable (heap does not grow >20 MB) |
| PRF-10 | P1 | M | Rapid switching while a bound-preset prompt is open (answer late) | One prompt at a time; no double activation |
| PRF-11 | P2 | M | **Rapid preset activation/deactivation** (toggle 30× in 30 s) | Tracker and filter consistent with the final state; no console errors |
| PRF-12 | P2 | M | Rapid **condition editing**: add/delete 30 conditions quickly | List consistent with `S().wiConditions`; no orphan entries; settings save debounced |
| PRF-13 | P2 | M | Open the WI editor and add a condition while a generation is running | No interference; probe/filter still correct afterwards |
| PRF-14 | P2 | M | MutationObserver cost: with the WI panel open and a chat streaming a long response | CPU stays reasonable (browser Performance tab: no long tasks attributed to `injectWIConditionUI`/`observeWIEditorChanges` >50 ms) |
| PRF-15 | P3 | M | Memory leak check: open/close the WI editor 100 times | Number of `MutationObserver`s and listeners does not grow (one observer total) |
| PRF-16 | P2 | A-new | Import a 50 000-condition bundle | Completes in seconds; conditions deduplicated in one pass (record; the duplicate check is a linear scan per condition) |

---------------------------------------------------------------------------

## 10. Regression checklist

Run after any change to the extension or an ST update. Existing behaviour that
must not change:

| ID | Area | Check |
|---|---|---|
| REG-01 | Variables | Create number/string/boolean/enum/array/calculated/datetime variables; values persist per chat; `{{getvar::se__hp}}` macro works |
| REG-02 | Presets | Create, rename, clone, delete, activate/deactivate presets; clone renames variables uniquely and rewires calculated variables |
| REG-03 | Datetime | A datetime variable and its calendar dropdown (built-in calendars) still work; formatted preview shows under the default input |
| REG-04 | Prompted updates | A prompted variable still updates from the LLM; batches unaffected |
| REG-05 | Tracker | Floating tracker shows values, edits static variables |
| REG-06 | Manager modal | All tabs open (Presets, Variables, Calendars, World Info, Variable Management, Debug) with no console errors |
| REG-07 | Settings panel | Existing controls (enable, wand, tracker panel, profile, temperature, max tokens, prompt history, header) still work |
| REG-08 | Namespaced API | `stateEngine.*` API calls (from other extensions) unchanged |
| REG-09 | Migration | Older settings load with no data loss |
| REG-10 | Console | No new errors or warnings at idle on page load and on chat switch |
| REG-11 | Automated | `npm run test:run` — all files pass |

---------------------------------------------------------------------------

## 11. Automation

### 11.1 Existing automated coverage — `tests/world-info-bindings.test.js`

Run: `npm run test:run` (this file: `npx vitest run tests/world-info-bindings.test.js`).
It runs against a simulated ST context — it proves the *logic*, not the real
ST integration, and does not exercise any browser UI.

In addition, **`tests/world-info-gap-fixes.test.js`** (116 tests) covers every fix in §12: the enable guard,
corrupt condition lists, editor escaping, object arrays, variable names, condition editing (its
pure parts), decline clearing, the API identity check, filter / `shouldDisplayWIEntry` parity, world-name
normalisation, bundle import/export tidiness and the dark-theme styling. The editor's click handlers are exercised by
**`tests/wi-editor-dom.test.js`** (26 tests, jsdom, against SillyTavern's real entry markup): injection
timing and idempotence, one box per expanded entry, entry keys from the selected book, add / edit /
delete / cancel, operator and value fields per variable type, object arrays, escaping. That suite is
what WIE-IN-01…10, WIE-AD, WIE-DL, WIE-ED, WIE-VF, WIE-IX and WIE-EK automate; the manual cases in §2
remain the check against a real SillyTavern (selectors can change between ST versions).

| Suite (describe block) | Covers |
|---|---|
| WI conditions persist | §1/§6: settings saved on set/update/delete/clear; no-op writes do not save |
| world name normalisation | WIF-WK-01…03, 09, 10 |
| conditional filtering | WIF-FL-01…04, WIF-MV-01, WIF-PR-01, WIF-TY-12, legacy key |
| the filter is registered on an event that can filter | WIF-FL-05 (source check), chat-change prompt registered |
| lorebook → preset bindings | LPB-BD-13…15, LPB-PS-03, LPB-RM-01, SET-MG-02 |
| auto-activating bound presets when a chat loads | LPB-AP-14, LPB-DM, LPB-MP-05 |
| preset export / import | PEX-EX-05, PEX-IM-08/09, PEX-UN-01…03, PEX-CV-01, PEX-CF-04, UI buttons present |
| lorebook bundles | LBE-EX-02/03/07/08/12, LBE-IM-02…04, LBE-MG-01/03/04, LBE-BAD-01/02 |
| window.StateEngineWI | API-01, API-23 wiring |
| the Lorebook Preset Bindings section | settings.html ids and UI function exports |

### 11.2 Backlog — automated tests to write (`[A-new]` items)

Create these files; each ID above maps to one `it`. Priority order:

1. **`tests/wi-operators.test.js`** — WIF-OP-01…47, WIF-RX-01…06. There is
   **no** automated coverage of the operator table today; this is the biggest gap.
   Approach: call `evaluateCondition(varName, operator, value)` with a preset and
   `context.variables.local` set (see `world-info-bindings.test.js` for setup).
2. **`tests/wi-corrupt-data.test.js`** — SET-CR-01…05, LPB-RM-06/07, WIF-FL-14,
   WIF-WK-11/12, PEX-CF-05…09, LBE-BAD-06/07/11/16. Each corrupt-data case must
   assert *no throw* and *no partial write*; cases still marked KNOWN GAP should be
   written to assert the **desired** behaviour and be left failing (`it.fails`) until fixed.
3. **`tests/wi-perf.test.js`** — PRF-01…03, 16 (time budgets, generous CI margins).
4. **`tests/wi-editor-dom.test.js`** — WIE-* cases using jsdom: inject into a
   fake ST entry form, assert operator lists per variable type, index field,
   save/cancel/delete flows, unescaped value rendering (WIE-RD-04), object-array
   Save error (WIE-VF-06). Needs `jsdom` as a dev dependency.
5. **`tests/lorebook-bindings-ui.test.js`** — LPB-BD-01…12 with jsdom and jQuery.

Also worth adding: a **contract test** that fails when ST's event/API names
change (INT-UP-04) — run against the ST checkout on the test machine.

### 11.3 Suggested CI order

`npm run test:run` on every commit → manual smoke (INT-UP-01) after each ST
update → full manual pass before each release.

---------------------------------------------------------------------------

## 12. Defect reporting and known-gap register

Log every failure as: **ID · title · build/ST versions · steps (copy from the
test) · expected · actual · console output · screenshots · the `state_engine`
settings excerpt (redact chat names if private) · severity (S1 data loss/crash,
S2 wrong filtering/prompts, S3 cosmetic)**.

Status of the gaps found in version 1.0 of this plan:

| # | Gap | Status |
|---|---|---|
| G1 | WI filter ignored the "Enable State Engine" switch | **FIXED** — guarded by `settings.enabled`; hook kept |
| G2 | One corrupt condition list stopped the filter pass | **FIXED** — only that entry is skipped (kept, warning logged) |
| G3 | Condition list / dropdown rendered values and names unescaped | **FIXED** — everything rendered is escaped |
| G4 | Editor showed variable ids | **FIXED** — shows `<preset> / <variable name>` (label, then id, as fallbacks) |
| G5 | No in-place edit of a condition | **FIXED** — Edit button; save replaces |
| G6 | Saving on an array-of-object variable threw | **FIXED** — value disabled with a message, save refused, no operators offered |
| G7 | Decline memory never cleared | **FIXED** — Clear Declines button; auto-cleared on binding change, lorebook unassigned from the chat, or manual activation. (Declines of deleted chats still linger until cleared — harmless) |
| G8 | Persona lorebook not considered for activation prompts | Open (unchanged, low priority) |
| G9 | `shouldDisplayWIEntry` differed from the filter | **FIXED** — one shared rule |
| G10 | `StateEngineWI` had no caller identity check | **FIXED** — same check and errors as `stateEngine.*` |
| G11 | Renaming a lorebook orphans conditions and bindings | Open — by design (keyed by name); documented in the compatibility notes |
| G12 | Non-numeric operands make numeric operators hide the entry | Open — operator table deliberately unchanged |
| G13 | Preset import accepts variables with no name | Open (out of scope for this pass) |
| G14 | Calculated-expression rewrite is a text rewrite | Open (out of scope) |
| G15 | Fixed light backgrounds on dark themes | **FIXED** — theme variables |
| G16 | Very long activation prompt with many presets/lorebooks | Open (design) |
| G17 | Possible dead code in `wi-manager-ui.js` | Open |

Also fixed in this pass (polish): world names normalised everywhere (10.1); bundle
import no longer creates orphan bindings, conditions or presets (10.2–10.4);
bundle export leaves out empty parts (10.5).

---------------------------------------------------------------------------

## 13. Entry, exit and traceability

**Entry criteria:** build installed and enabled; §0.6 data created; console
clean at idle; automated suite green.

**Exit criteria:** all P1 cases pass or have an accepted, recorded deviation;
no open S1/S2 defects (G-items with a *decision* recorded count as resolved);
all P2 cases executed; regression checklist (§10) passes; the automated suite
is green; performance budgets (§9) met.

**Traceability** — feature → sections:

| Requirement | Cases |
|---|---|
| Conditions persist | WIF-*, SET-PS-*, WIE-AD-02, WIE-DL-05 |
| World name normalisation | WIF-WK-*, WIE-EK-* |
| Working filter on the right event | WIF-FL-*, INT-* |
| Fail-open for missing/declined presets | WIF-MV-*, WIF-PR-*, LPB-AP-03 |
| Lorebook → preset bindings | LPB-* |
| Auto-activation prompt | LPB-AP-*, LPB-MP-*, LPB-DM-* |
| Preset export/import | PEX-* |
| Lorebook bundle export/import | LBE-* |
| `window.StateEngineWI` | API-* |
| Settings migration and safety | SET-* |
| Performance/stress | PRF-* |

**Test-case count:** 451 numbered cases (revision 1.1 added the 31 in §14; the counts by type in
version 1.0 were 294 manual, 39 automated-covered, 76 to be automated, 11 regression checks).
Many FIXED rows now also carry an **[A]** reference.

**Sign-off:** Tester ____________ Date ________ Build ________ ST version ________

---------------------------------------------------------------------------

## 14. Gap-fix verification cases (revision 1.1)

Manual checks for the behaviour added or changed by the gap-resolution pass. Automated
coverage is in `tests/world-info-gap-fixes.test.js`.

| ID | Pri | Type | Scenario | Expected |
|---|---|---|---|---|
| FIX-EN-01 | P1 | M+A | Entry 1 has an unmet condition. Probe. Untick **Enable State Engine**. Probe again | Entry 1 absent, then present |
| FIX-EN-02 | P1 | M | Tick it again; probe | Entry 1 absent again, no reload needed |
| FIX-EN-03 | P2 | M | With State Engine disabled, the editor box and bindings section still open; existing conditions are kept in settings | Nothing is deleted |
| FIX-ED-01 | P1 | M | Click **Edit** on a condition; check every field | Variable (by name), operator and value pre-filled; button says **Save changes** |
| FIX-ED-02 | P1 | M | Change the value, **Save changes** | Row updates in place; `S().wiConditions[key]` has the same count; order unchanged |
| FIX-ED-03 | P1 | M | Edit, then **Cancel** | Nothing changed; button label back to **Add condition** |
| FIX-ED-04 | P1 | M | Edit an `index_eq` condition | Index and value shown separately; saving keeps the `index:value` form |
| FIX-ED-05 | P2 | M | Edit a condition whose variable's preset is not active | The variable is listed as `(not available) <id>` and stays selected; saving does not change it |
| FIX-ED-06 | P2 | M | Start an edit, then delete a condition of the same entry | The edit is abandoned (no wrong row overwritten) |
| FIX-ED-07 | P2 | M | After **Save changes**, click **Add condition** | Editor is empty and in add mode; saving adds a new condition |
| FIX-ES-01 | P1 | M | Add a condition with value `<b>x</b>`; view in the WI editor and in Manager → World Info | Literal text in both; no formatting; no script runs |
| FIX-ES-02 | P1 | M | Name a preset `<i>P</i>` and a variable `a"b`; open the condition editor | Both shown literally in the dropdown |
| FIX-OB-01 | P1 | M | Pick the array-of-object variable | Operators disabled/none; value disabled with note; Save refused with an alert |
| FIX-OB-02 | P1 | M | Pick it, then switch to `hp` | Operators and value box return to normal |
| FIX-DC-01 | P1 | M | Decline a prompt. Click **Clear Declines** | Status "Cleared N declined preset prompt(s)"; reopening the chat asks again |
| FIX-DC-02 | P1 | M | **Clear Declines** with nothing declined | Status "There were no declined prompts to clear." |
| FIX-DC-03 | P1 | M | Decline, then bind another preset to that lorebook | Chat asks again (both presets) |
| FIX-DC-04 | P1 | M | Decline, then activate that preset yourself in that chat (Manager toggle), deactivate it, reopen | Asks again (its decline was cleared by the manual activation) |
| FIX-DC-05 | P1 | M | Decline, then detach the lorebook from the chat, reopen, re-attach, reopen | Asks again |
| FIX-DC-06 | P2 | M | A decline in Chat-A must not be cleared by activating the same preset in Chat-B | Chat-A still remembers |
| FIX-ID-01 | P1 | M | `StateEngineWI.getWIConditions('QA-Book.1')` (old style, no identity) | Rejected with the `wrong instance` error — the call signature changed |
| FIX-ID-02 | P1 | M | Every function with `...me` prepended | Works |
| FIX-ID-03 | P1 | M | `StateEngineWI.exportLorebookBundle('x','y','QA-Book')` | Throws immediately (not a rejected promise) |
| FIX-PA-01 | P1 | M | For 10 entries covering every condition situation (§1–§1.7), compare `StateEngineWI.shouldDisplayWIEntry(...me, key)` with the probe | Always the same answer |
| FIX-WN-01 | P2 | M | Bind a preset with a blank lorebook name via the API | Stored under `default` |
| FIX-BI-01 | P1 | M | Import a bundle whose `wiConditions` has a key for an entry uid the lorebook lacks | That condition is not imported |
| FIX-BI-02 | P1 | M | Import a bundle with a preset that is neither bound nor used by a kept condition | That preset is not imported |
| FIX-BI-03 | P1 | M | Import a bundle whose binding names a preset absent from `presets` | No binding, no empty entry in `lorebookPresetBindings` |
| FIX-BI-04 | P1 | M | Export a lorebook with no State Engine data | `stateEngine` is `{}` |
| FIX-BI-05 | P2 | M | Export with an empty condition list under one entry key | Key not in the file |
| NCS-01 | P1 | M | Chat A (character X) has presets Vitals + Mood active and some values. Create a NEW chat with X | A dialog appears **before** the chat carries on, naming chat A, its presets and the number of stored variables, with three buttons: **Same presets, no data**, **Continue (presets + data)**, **Clean slate** |
| NCS-02 | P1 | M | Choose **Same presets, no data** | Manager → Presets shows Vitals + Mood active; tracker shows their variables at DEFAULT values, not chat A's |
| NCS-03 | P1 | M | Repeat with **Continue** | Same presets active; values equal chat A's; chat A unchanged |
| NCS-04 | P1 | M | Repeat with **Clean slate** | No presets active; no variables; chat A unchanged |
| NCS-05 | P1 | M | Close the dialog (X / Escape) | Same as Clean slate |
| NCS-06 | P1 | M | Create a new chat with a character you have never chatted with (or whose earlier chats had no presets and no variables) | No dialog; empty chat |
| NCS-07 | P1 | M | Switch between two EXISTING chats | No dialog (only creating a chat asks) |
| NCS-08 | P2 | M | Create a new **group** chat with a group that has an earlier chat | The same dialog appears |
| NCS-09 | P2 | M | Character whose lorebook has bound presets | The lorebook prompt may appear first (SillyTavern emits chat-changed before chat-created); presets activated there stay active whichever start you pick |
| NCS-10 | P2 | M | Continue when chat A has a variable whose preset is no longer active there | That orphan value is not copied |
| NCS-11 | P2 | M | Preset names containing `<b>` or `&` | Dialog shows them as text |
| NCS-12 | P2 | M | Create the new chat, choose one option, open the manager | Manager shows the new chat's presets (see the manager-refresh fix), not the previous chat's |
| FIX-TH-01 | P2 | M | Dark theme, light theme, custom theme: open the WI editor's State Engine box, add/edit dialogs | Text and backgrounds contrast on all |
