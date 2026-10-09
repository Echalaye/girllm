# Chat and memory

## The chat

The page has a sidebar with your characters and their chats, her portrait in the header, light and dark themes,
and works with the keyboard and screen readers; it also fits a phone-sized window (for a real phone, see the
[phone app](mobile-app.md)).

- **Replies stream in** as she writes them, with **Stop** and **Regenerate** ("swipe") buttons.
- **Saved chats**: every chat is kept (SQLite) and survives a restart. Reopen any previous chat from the chat list,
  or start a new one; deleting a chat keeps what she remembers about you.
- **Two writing styles** per character: `texting` (short, natural phone messages) or `roleplay` (narrative with
  _actions_ in italics, the default for community cards).
- **She knows what time it is**: day, hour, and how long since your last message. No more "good morning" at
  11 pm, and a three-day silence gets noticed.
- **Less repetition**: the prompt points out how her last replies started and the phrases she keeps reusing.
- **Token-budgeted prompt**: the character definition is always kept; when the context is full, the oldest
  messages are folded into the summary (below) or dropped first.
- Stop sequences so the model doesn't write your lines for you.

### She writes first

- A character without a fixed first message **opens each new chat herself**, in tune with the time of day.
- After a silence (`PROACTIVE_AFTER_MINUTES`, 60 by default, `0` = never) she **texts you on her own**, once, never
  twice in a row. A message that arrives while the tab is in the background shows up in the tab title.

### Photos and voice in the chat

- 📷 asks for a photo, and she also sends photos on her own when it fits: see [Photos](photos.md).
- 🎤 to talk instead of typing, 🔊 on each of her messages, **Voice on** to hear every reply, and a hands-free
  **call**: see [Voice](voice.md).

## Memory

She remembers you across chats:

- **Running summary ("story so far")**: when the chat gets long, older messages are folded into a summary that stays
  in the prompt, instead of being silently forgotten.
- **Long-term memories**: facts about you, her, your relationship and events are extracted automatically and shared
  by **every chat with that character**. The most relevant ones are found by semantic search for each reply.
- **Mood**: her current mood is tracked and carried into the next replies.
- **Memory panel**: see the summary and mood, add memories by hand, and make her forget wrong ones.

### How it works

```
each reply ─► prompt = character card
                     + relevant long-term memories (semantic search on your last message)
                     + story so far (running summary)
                     + current mood
                     + recent messages, verbatim
           ─► after the reply, in the background (never blocks the chat):
                1. if the verbatim history is above ~50% of the context: summarize its oldest part
                2. every few messages: extract new facts + mood (JSON), de-duplicate, store
```

- These background tasks use **your chat model**, so right after a reply Ollama may be busy for a few seconds. A
  message sent meanwhile simply waits its turn.
- The latest reply is only mined for facts once you answer it, so regenerating a reply never leaves "ghost"
  memories behind.
- Memories belong to a **character**: a new chat with her still knows what she learned before. Deleting a chat
  keeps its memories; use the Memory panel to remove them. Deleting the character deletes them.
- Memory search uses the embedding model (`EMBEDDING_MODEL`, `paraphrase-multilingual` by default). Vectors are only
  compared with vectors from the same model, so changing it never mixes incompatible results; older memories then
  rank by recency until they are learned again.
- **VRAM**: the embedding model is small (~0.6 GB), but with a 12B model already filling 8 GB, Ollama may swap
  models. If replies get slow, set `EMBEDDING_MODEL=` (recency-only memories) or use a 7–8B chat model.
- `MEMORY_ENABLED=false` turns memory off (chats are still saved). Tuning: `MEMORY_TOP_K`, `MEMORY_EXTRACT_EVERY`
  in [Configuration](configuration.md).

All of it is stored in `data/girllm.db`, unencrypted, on your PC only: see [Security](security.md#your-data).
