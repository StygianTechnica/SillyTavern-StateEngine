# State Engine

A SillyTavern extension for keeping track of "state" — stats, relationship meters, flags, counters,
whatever — **locally**, instead of asking the AI to print a tracker block in every reply.

A floating **tracker panel** shows the live values (works as a plain old room/relationship/stat
tracker on its own, or as a debug view into what State Engine is doing in the background), prompted
variables can be told to update at any of the same moments you'd bind a Quick Reply to, and
background updates can be routed through their own **Connection Profile** — a different, cheaper
model than the one running your actual roleplay, if you want.

State variables live in SillyTavern's own local variable store (per-chat or global), are readable
anywhere macros work — World Info, prompts, character cards — as `{{getvar::variablename}}`, and
never appear in the visible chat log. Three kinds of variable are supported:

- **Manual** — you set the value yourself (via the panel, or SillyTavern's built-in `/setvar` and
  friends). No automation.
- **Counter** — increments or decrements by a fixed step automatically, on every user message,
  every AI message, or both. Good for turn counters, cooldowns, simple tallies.
- **Prompted** — you write a short instruction ("track how suspicious the character is of the
  user, 0–100, increase on lies, decrease on honesty"), and State Engine periodically runs a
  *silent background generation* that asks the AI to output an updated value. This exchange is
  invisible — it's a separate call, not a chat message, so it never bloats your context or shows
  up in the transcript.

All "prompted" variables that share a trigger are batched into a single background call (one
JSON request/response) rather than one call per variable, to keep this cheap.

## Install

1. Download and unzip this extension.
2. Copy the `StateEngine` folder into your SillyTavern extensions directory:
   - Current SillyTavern versions: `data/<your-user-handle>/extensions/StateEngine/`
   - Older versions: `public/scripts/extensions/third-party/StateEngine/`

   (If you're not sure which applies, look for whichever of those two paths already exists in
   your install — that's the one to use.)
3. Restart SillyTavern (or reload the page) and open the **Extensions** panel.
4. Find **State Engine** in the list and make sure it's enabled.

## Usage

1. Open the **State Engine** drawer in the Extensions panel.
2. Click **Add variable** and fill in:
   - **Variable name** — the key you'll use as `{{getvar::name}}`. Letters, numbers, underscores
     only.
   - **Category** — Manual, Counter, or Prompted (see above).
   - **Scope** — "This chat" (stored with the chat, resets per-conversation) or "Global" (shared
     across every chat).
   - **Value type** — Number, Text, True/False, or a fixed Choice list.
   - **Default value** — applied the first time the variable is seen (e.g. a new chat, or right
     after you create the variable).
   - For **Counter**: which message triggers the step, direction, and step size.
   - For **Prompted**: which message triggers a re-evaluation, and the instructions the AI should
     follow.
   - Optionally: min/max bounds (numbers), allowed values (choice lists), and whether the variable
     resets to its default whenever you start a brand-new chat.
3. Click **Save variable**. The current value shows live in the variables table.
4. Reference it anywhere macros are supported:

   ```
   {{getvar::affection}}
   ```

   For example, in a World Info entry:

   ```
   Current affection level toward {{user}}: {{getvar::affection}}/100
   ```

   World Info entries, the character card, and the prompt itself will all resolve this to the
   live value at generation time.

### Running prompted updates on demand

Use the **Run prompted updates now** button (or the `/state-run` slash command, if your
SillyTavern version supports the newer slash-command API) to force every "Prompted" variable to
re-evaluate immediately, regardless of its configured trigger.

### When a "Prompted" variable updates

Each Prompted variable has its own set of update checkboxes, mirroring the moments you'd normally
bind a Quick Reply's automation to:

- **App / chat startup** — once, the first time State Engine finishes loading.
- **New chat created** — when you start a brand-new chat (distinct from switching to an old one).
- **Any chat switch** — every time you open a chat, new or existing.
- **After user message** — every time you send a message.
- **Right before AI generates** — fires as generation begins. Since the update is itself a
  separate AI call, it's usually not fast enough to affect the very reply that triggered it — treat
  it as "update just in time for next turn," not as blocking the current one.
- **After AI message** — every time the AI replies.
- **Group member drafted** — for group chats, each time a member is drafted to respond.

Check as many or as few as you like; leaving all of them unchecked means the variable only updates
via the manual button / `/state-run`.

### General settings

- **Show floating tracker panel** — see [Tracker panel](#tracker-panel) below.
- **Chat history sent to the AI for prompted updates** — how many recent messages are included
  when State Engine asks the AI to derive a value. Keep this small (5–15) to keep the background
  call cheap and fast.
- **Max response length for updates** — token cap on the background generation's reply.
- **Connection profile for prompted updates** — see [Connection profile](#connection-profile)
  below.

## Tracker panel

Turn on **Show floating tracker panel** in the settings drawer to get a small, draggable box
listing every variable's current value — drag it by its header anywhere on screen, and it'll
remember where you left it. It updates live as counters step, prompted updates land, and you
switch or create chats.

This works two ways at once:

- As a **plain state tracker** for the chat — turn off "Show on the tracker panel" (in a
  variable's editor) for anything you consider internal bookkeeping, and the panel becomes a clean,
  regular-looking stat/relationship/room tracker with just the variables you want a reader to see.
- As a **debug view** — click the **Debug** button in the panel's header to also reveal variables
  you've hidden from the normal view (shown dimmed/italic), so you can watch everything State
  Engine is tracking in the background, including anything you're using purely for automation
  bookkeeping (e.g. a counter that gates when a prompted variable is allowed to re-run).

The **–** button collapses the panel to just its title bar; **×** hides it (same as unchecking the
settings checkbox).

## Connection profile

By default, prompted updates run through whatever connection/model you're currently chatting with.
If you'd rather not spend your main model's tokens (or want faster/cheaper background updates),
pick a saved [Connection Profile](https://docs.sillytavern.app/usage/core-concepts/connection-profiles/)
from the dropdown in settings — State Engine will route every prompted-update request through that
profile instead, independent of your active chat connection. Leave it on "Use currently active
connection" to just use whatever you're already talking to. If the selected profile ever becomes
unavailable, or the underlying API doesn't support it in your SillyTavern version, updates fall
back to the currently active connection automatically (and a note is logged to the console) rather
than silently failing.

## How it works, briefly

- Variable *values* are stored using SillyTavern's native local/global variable system (the same
  storage backing `{{getvar}}`/`{{setvar}}`/`{{incvar}}`/`{{decvar}}`), so they persist with the
  chat automatically and are visible to macros with zero extra wiring.
- Variable *definitions* (name, category, automation rules, prompted instructions) are stored in
  the extension's own settings and apply across all chats.
- Prompted updates use an isolated background generation (SillyTavern's "raw" generation API) —
  it is not appended to the chat, and it doesn't consume your normal generation's context budget.
  The model is asked to return a single JSON object mapping variable names to updated values; the
  response is parsed and validated (type-coerced, clamped to min/max, restricted to allowed
  choices) before being written to storage. If the model's reply can't be parsed as JSON, the
  update is skipped and a note is logged to the browser console (`[State Engine] ...`) rather than
  silently corrupting a value.

## Known limitations / roadmap ideas

- Variable *definitions* are extension-wide, not per-character. If you want different characters
  to track different things, use distinct variable names per concept (or just reuse the same
  variables loosely) — per-character schema binding is a reasonable future addition.
- There's no expression/formula variable type yet (a value computed from other variables). Counter
  and Prompted cover the requested "auto increment/decrement" and "AI-derived" cases; a computed
  type would be a natural follow-up.
- World Info **activation keys** are still plain keyword matching — macros aren't evaluated there,
  only inside entry *content*. You can still get conditional-feeling text inside an entry's content
  using SillyTavern's built-in `{{if}}`/`{{else}}` macros together with `{{getvar::name}}`; test the
  exact syntax against your SillyTavern version.
- This was built against SillyTavern's documented extension API as of August 2026. If something
  doesn't load, open the browser console and look for `[State Engine]` log lines — the extension
  fails soft (logs and continues) rather than throwing on non-critical API mismatches like slash
  command registration or connection-profile routing (a failed profile request automatically falls
  back to your active connection).
- "Pre-generation" prompted updates don't block or wait for the generation they precede — see the
  trigger list above.

## Files

```
StateEngine/
├── manifest.json    extension metadata
├── index.js         all extension logic
├── settings.html     settings-panel markup
├── style.css         settings-panel styling
└── README.md         this file
```
