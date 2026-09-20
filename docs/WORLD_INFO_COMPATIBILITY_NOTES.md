# State Engine and SillyTavern World Info — Compatibility Notes

*A guide for people who use lorebooks (World Info) with State Engine.*

State Engine adds an optional layer on top of SillyTavern's World Info. This
guide explains what that layer does, what it leaves alone, and how to mix
State Engine lorebooks with ordinary ones without surprises.

---

## At a glance

| Question | Answer |
|---|---|
| Does State Engine change my lorebook files? | **No.** It never edits a lorebook. |
| Do my lorebook exports contain State Engine data? | **No.** They are the same files SillyTavern always makes. |
| Where do State Engine's conditions and bindings live? | In State Engine's own settings, separate from your lorebooks. |
| Do I have to use State Engine's features? | **No.** Lorebooks with no conditions behave exactly as before. |
| Can I share a lorebook with someone who doesn't have State Engine? | **Yes**, with SillyTavern's normal export. |
| What needs State Engine to open? | State Engine **bundles** only. |

---

## 1. Overview

**What State Engine adds.** State Engine keeps track of story *variables*
(things like health, mood, or whether a door is unlocked). For World Info it adds
three optional things:

- **Conditions** — you can tell an entry to appear only when a variable has a
  certain value (for example, "only when *trust* is above 5").
- **Preset bindings** — you can link a lorebook to the State Engine *presets*
  (sets of variables) that it depends on, so State Engine can offer to switch
  them on for you when you open a chat that uses that lorebook.
- **Bundles** — you can export a lorebook *together with* its conditions,
  presets and bindings as one file, and import it somewhere else.

**SillyTavern's World Info stays intact.** Everything SillyTavern does with
lorebooks — creating and editing entries, keywords, the settings you already
use, importing, exporting — works the same way. State Engine is a helper on the
side, not a replacement.

---

## 2. What SillyTavern's World Info still does (unchanged)

- **Entries, editing and keyword matching.** You create and edit entries in
  SillyTavern's World Info editor as usual. Keywords, constant entries,
  recursion, budgets and the rest are decided by SillyTavern. State Engine adds
  one small box to each entry's editor (see section 3); the rest of the editor
  is untouched.
- **Native export and import.** SillyTavern's own lorebook export still gives
  you a plain lorebook file. **It contains no State Engine information** —
  no conditions, no presets, no bindings — because State Engine never puts any
  into the lorebook.
- **Storage.** State Engine does not change how or where SillyTavern stores
  lorebooks. Your lorebook files remain exactly the files SillyTavern created.
  (The one time State Engine writes a lorebook is when *you* import a bundle;
  it saves it through SillyTavern in the normal format. See section 5.)

---

## 3. Conditional display

**How it works.** Each entry can have one or more conditions, added in the
**State Engine Conditions** box inside the entry editor. Before SillyTavern
looks through your lorebook for matches, State Engine checks each entry that has
conditions:

- If **all** of its conditions are true right now, the entry is left in and
  SillyTavern treats it normally (keywords and everything else still apply).
- If **any** condition is false, the entry is left out for that moment, as if it
  were switched off. It can't be triggered by keywords, and it doesn't use up
  your lorebook budget.

Entries **without** conditions are never touched.

**Where conditions are stored.** In State Engine's own settings, kept by
lorebook name and entry number (for example, "*My Book*, entry 12"). They are
**not** written into the lorebook.

**Nothing in the lorebook changes.** The check happens in the moment, while
your prompt is being prepared. The entry is not edited, disabled or deleted; if
the condition becomes true later, the entry is back the next time.

**Conditions never appear in a native export.** Export a lorebook with
SillyTavern and the file is identical to what you'd get without State Engine.

**When State Engine can't decide, the entry stays visible.** If a condition
refers to a variable that isn't available in the current chat (its preset isn't
switched on, or the variable was deleted), or the condition is faulty or its
stored data is damaged, the entry is **shown** rather than hidden. A damaged
condition only affects **its own entry**: every other entry is still checked as
normal. This means a lorebook never goes quietly empty just because a preset is
missing or something was corrupted.

**Editing conditions.** In the entry editor, each condition has an **Edit**
button (change it in place) and a **Delete** button. Variables are shown by name
(for example *My Preset / health*). Conditions can't be set on **arrays of
objects** yet; the editor says so and won't save one. Anything you type into a
condition is shown exactly as typed, never treated as formatting or code.

---

## 4. Presets and lorebook bindings

- **Presets stay per chat.** Each chat has its own set of active presets and its
  own variable values. Linking a preset to a lorebook doesn't change that: a
  preset is only active in the chats where you (or you, by answering a prompt)
  switched it on.
- **Bindings are stored in State Engine, not in the lorebook.** A binding is a
  note saying "this lorebook works with these presets", kept in State Engine's
  settings.
- **Bindings don't affect native export or import.** A lorebook exported or
  imported the normal way neither carries nor loses any bindings.

**What a binding does for you.** When you open a chat whose lorebook has bound
presets that aren't active yet, State Engine asks whether to activate them.
Answer **Yes** and they're switched on for that chat. Answer **No** and nothing
is activated; State Engine remembers your answer for that chat so it doesn't
keep asking. (With the presets off, any condition that depends on them is
ignored and the entries stay visible.)

A remembered **No** is forgotten automatically when it stops being true:

- when you change which presets are linked to that lorebook;
- when the lorebook is taken off the chat (asked again if you put it back);
- when you switch the preset on yourself in that chat.

You can also forget all of them at any time with **Clear Declines** in
*Extensions → State Engine → Lorebook Preset Bindings*.

---

## 5. Bundles

**Native export vs. bundle export.**

| | Native lorebook export | State Engine bundle |
|---|---|---|
| Made by | SillyTavern | State Engine |
| Contains | The lorebook only | The lorebook **plus** its conditions, the presets it uses, and its bindings |
| Opens in | SillyTavern (and anything that reads lorebooks) | State Engine only |
| Needed to use it | Nothing extra | The State Engine extension |

**What a bundle includes.**

- the lorebook itself, in SillyTavern's normal format;
- the **conditions** set on that lorebook's entries;
- the **presets** bound to that lorebook (their variables and settings — not
  the values from your chats);
- the **bindings** linking them.

**Bundles are optional.** They are an extra convenience for moving a *complete*
State Engine setup between installations. They don't replace SillyTavern's
export, and you never need one to use a lorebook.

**Importing a bundle.** State Engine adds the lorebook to SillyTavern, adds the
presets, and re-attaches the conditions and bindings. Some safeguards:

- If a lorebook with the same name already exists, you're **asked before it is
  overwritten**.
- Imported presets **never overwrite** yours. If a name is already in use, the
  copy gets a new name; if you import the same bundle twice, the matching preset
  is reused rather than duplicated.
- Conditions are re-linked to the imported variables automatically.
- Nothing half-finished is left behind: a condition for an entry the lorebook
  doesn't have, or on a variable that doesn't exist, is skipped; a preset is only
  brought in if the bundle links it to the lorebook or a condition uses it; and
  links are only made to presets that really exist afterwards.
- Afterwards you're asked whether to activate the presets for the current chat.

A bundle only contains what the lorebook actually has: if it has no conditions or
no linked presets, those parts are simply left out of the file.

---

## 6. Using State Engine and native lorebooks together

- **You can ignore State Engine completely for any lorebook.** A lorebook with
  no conditions and no bindings behaves exactly as it did before State Engine
  was installed.
- **You can mix both kinds.** In the same chat, some lorebooks can use
  State Engine conditions while others are plain. State Engine only looks at
  entries that have conditions; everything else is passed straight to
  SillyTavern.
- **Turning State Engine off restores pure native behavior.** Either way works:
  - **Untick "Enable State Engine"** in State Engine's settings: variable
    updates stop **and conditions stop hiding entries** straight away — every
    entry is passed to SillyTavern untouched. Tick it again and conditions apply
    again, no reload needed.
  - **Disable the extension** (SillyTavern → Extensions → State Engine, then
    reload): the same, and the State Engine boxes and settings disappear too.
  Nothing is deleted either way: switch it back on and your conditions, bindings
  and presets are still there.
- **Your lorebook is safe either way.** Because conditions live outside the
  lorebook, removing State Engine never damages or empties a lorebook.

---

## 7. Limitations and known gaps

- **Bundles need State Engine.** SillyTavern on its own cannot read a bundle.
  (Its lorebook import expects a plain lorebook file.)
- **Conditions follow the lorebook's name and the entry's number.** If you
  **rename** a lorebook, its conditions and bindings don't follow; they stay
  under the old name and stop applying, and the entries are simply shown.
  Re-add them under the new name. Deleting an entry leaves its conditions
  behind, unused. A duplicated entry starts with no conditions.
- **Conditions and bindings are part of State Engine's settings, not your
  lorebook.** Copying just the lorebook file to another computer does **not**
  bring them. Use a bundle for that. Likewise, resetting or losing SillyTavern's
  settings loses them.
- **Presets must be active for conditions to matter.** A condition can only
  test a variable from a preset that is switched on in the current chat;
  otherwise it is ignored (the entry stays visible).
- **Character-card lorebooks.** Conditions apply to lorebooks SillyTavern has
  loaded. A lorebook embedded in a character card gets conditions only after it
  is imported as a normal lorebook.
- **Persona lorebooks** aren't checked when State Engine offers to activate
  presets. Conditions on their entries still work.
- **A "No" is remembered** for that chat until something changes (see section 4)
  or you press **Clear Declines**. You can switch the presets on yourself at any
  time. (Remembered answers for chats you have deleted stay in the settings until
  you press **Clear Declines**; they do no harm.)
- **Adding a condition or a link doesn't switch presets on by itself.** The
  activation question is asked when a chat is opened or switched to, not the
  moment you add a link. To use a preset right away, switch it on in the
  manager.
- **No conditions on arrays of objects** (yet): the editor explains this and
  won't save one.
- **Requires a recent SillyTavern.** Conditional display needs a SillyTavern
  version that provides the hook it uses (1.18 was used for testing). On older
  versions the extension shows a note in the browser console and conditions
  simply don't apply.

---

## 8. Recommendations

**Use SillyTavern's native export when…**

- you want a backup or copy of the lorebook itself;
- you're sharing with anyone who might not use State Engine;
- you're posting a lorebook publicly or moving it between tools;
- the lorebook has no State Engine conditions.

**Use a State Engine bundle when…**

- you want the lorebook to work as intended on another computer or for another
  State Engine user — conditions, presets and bindings included;
- you're backing up a lorebook that depends on State Engine, so nothing is left
  behind.

**Sharing with people who don't have State Engine.**

1. Use SillyTavern's normal **export** to share the lorebook. It works
   everywhere, but every entry will show regardless of conditions — the
   conditions aren't part of that file.
2. Tell them which entries are meant to be conditional, or share your bundle
   *as well* for anyone who does use State Engine.
3. If you only have a bundle, the lorebook inside it is stored in the standard
   format; it can be copied out into a plain lorebook file. If you're not
   comfortable doing that, re-export the lorebook from SillyTavern instead.

**Good habits.**

- Keep a native export of important lorebooks *and* a bundle of the ones that
  use conditions.
- Back up SillyTavern's settings occasionally — that is where your conditions
  and bindings are kept.
- Test a new conditional entry once by changing the variable and checking that
  the entry appears and disappears as expected.
- If you rename a lorebook that has conditions, re-check them afterwards.

---

*If something here doesn't match what you see, please report it — these notes
describe State Engine's behavior at the time of writing.*
