# Prompt Message Cues

When State Engine asks the model to update prompted variables, it sends the chat as labelled
sections. A variable's instructions can name these sections to say which messages to look at.

## The sections

```
Recent conversation:
Bot: The tavern is quiet.

Latest turn:
User: We walk to the market and haggle all afternoon.
Alice: The stalls are closing by the time we're done.
Bob: Lanterns flicker on as dusk falls.

Most recent roleplay message:
Bob: Lanterns flicker on as dusk falls.
```

| Cue | What it contains | Shown when |
|---|---|---|
| **Recent conversation** | Older context: every message sent before the latest turn. | There is history before the latest turn. |
| **Latest turn** | The last user message and every reply after it, oldest first. It ends with the most recent message. | The turn is more than one message. When it isn't shown, the latest turn *is* the most recent roleplay message. |
| **Most recent roleplay message** | The single last message in the chat, from the user or a character. | Always, when the chat has at least one message. |

"The latest message" in an instruction means the **Most recent roleplay message**. It never
means the "Output the JSON object now" line State Engine adds at the end of the request.

## Which cue to use

| You want… | Say… |
|---|---|
| Everything that happened since the user last spoke (time passed, distance travelled, money spent) | "…during the **Latest turn**" |
| Only the newest message (who spoke last, the current speaker's mood) | "…in the **Most recent roleplay message**" |
| Background only, never a reason to change the value | "Use the **Recent conversation** for context only." |

Example datetime instruction:

> Estimate how much in-story time passed during the Latest turn, e.g. "advance 3 hours". If no
> time passed, repeat the current value.

## What the trigger changes

- **Preset triggered on a user message:** the latest turn is just that user message, so the
  Latest turn and the Most recent roleplay message are the same.
- **Preset triggered on an AI message:** the latest turn is the user's message plus every AI
  reply since. In a group chat that includes every character who replied.

A preset that runs on **both** triggers sees the user message twice: alone, then again as the
start of the full turn. For a time variable that could count the same time twice, so trigger
it on AI messages only.

## Limits

- The whole latest turn is always sent, even when it is longer than the context message count.
  It is still cut at the **max prompt history** setting. When that cut drops the user message,
  everything that is sent counts as the latest turn.
- A hidden (ghosted) or blank user message does not start a new turn.
- The built-in prompted header defines these terms, and stays current across updates unless
  you write your own. Your own header replaces it: describe the sections in it yourself. When
  the built-in changes, State Engine posts one notification so you can compare and choose.
