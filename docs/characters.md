# Characters

A character is a **card**: who she is, how she writes, how she looks in pictures and how she sounds. girllm uses
the Character Card V2/V3 format, so cards from SillyTavern or chub.ai work as they are.

## Creating and editing

- **New character** (sidebar) or the ✏ pencil next to a character opens the **editor**: name, how she writes
  (text messages or roleplay), who she is, personality, situation, first message, plus the advanced card fields
  (example dialogue, system prompt, post-history instructions, creator notes, tags).
- **Import a card**: `.json` or `.png` cards from SillyTavern / chub.ai. You can also drop card files into
  `characters/` and restart.
- **Export card** downloads a compatible V2 JSON.
- **Delete** removes the character and also her chats, photos, memories, face and voice (after a confirmation).

The same editor is available in the [phone app](mobile-app.md).

## Her look

- **In pictures: Woman / Man** and **Realistic / Anime**: which image model draws her and how prompts are written
  ([Photos](photos.md)).
- **Appearance in pictures**: a fixed description used for **every photo** ("woman, 26 years old, shoulder-length
  wavy auburn hair, green eyes, …"). Without it the chat model improvises her look from the description, which
  varies between photos. A _descriptive_ age ("in her mid-twenties") gives more natural results than a number.
- **Reference face**: generate 4 portraits from her appearance and pick one, or upload a photo after confirming it
  is AI-generated, of yourself, or of an adult who agreed. Uploads are re-written without their metadata (EXIF,
  GPS, text). The face is her avatar and is applied to her photos so she looks the same in all of them.
- **Background**: her picture behind the chat, either her scene or her latest photo
  ([Photos → Her picture behind the chat](photos.md#her-picture-behind-the-chat)).

## Her voice

Describe how she sounds and create a voice, or record a real voice (yours, or an adult's who agreed). Every
message she speaks then uses that exact voice. See [Voice](voice.md#her-voice-in-the-editor).

## Where cards are stored

Cards created or edited in the app are saved as `characters/<id>.json` (Character Card V2, SillyTavern-compatible).
Editing a `.png` card (or a `.json` with another file name) saves the new `.json` and moves the original to
`characters/.originals/`, so nothing is lost and it isn't loaded twice. Card files are written atomically
(temporary file + rename) and validated by re-reading them before they replace anything.

Reference faces live in `data/faces/`, backgrounds in `data/backgrounds/`, voices in `data/voices/`: they are not
part of the card.

## Card fields

Supported macros in card fields: `{{char}}`, `{{user}}` (and the legacy `<BOT>` / `<USER>`). Your name comes from
`USER_NAME` (or ⚙ Settings).

| Card field                               | Used for                                                                                                                                                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system_prompt`                          | Replaces the default instructions (if not empty)                                                                                                                                                                             |
| `description`, `personality`, `scenario` | Character definition in the system prompt                                                                                                                                                                                    |
| `mes_example`                            | Example dialogue (style reference). Blocks separated by `<START>`                                                                                                                                                            |
| `first_mes`                              | Greeting that opens every new chat                                                                                                                                                                                           |
| `post_history_instructions`              | Reminder added at the end of the system prompt (strong steering)                                                                                                                                                             |
| `extensions.girllm.style`                | `"texting"` (short natural messages) or `"roleplay"` (narrative, default). Ignored if the card has its own `system_prompt`                                                                                                   |
| `extensions.girllm.artStyle`             | `"realistic"` (default) or `"anime"`: which image model and prompt conventions draw her                                                                                                                                      |
| `extensions.girllm.gender`               | `"female"` (default) or `"male"`: `1girl`/`1boy`, woman/man in pictures                                                                                                                                                      |
| `extensions.girllm.background`           | `"scene"` (default: her generated scene) or `"latest"` (her latest photo in the chat) behind the chat                                                                                                                        |
| `extensions.girllm.voiceDescription`     | What her voice sounds like (≤ 500 chars), used to design it (step 7). The voice itself is a clip in `data/voices/`, not in the card. The step 3 field `voice` is dropped when the card is saved                              |
| `extensions.girllm.appearance`           | Fixed look used for **every photo** (image-prompt tags): `"woman, 26 years old, shoulder-length wavy auburn hair, green eyes, …"`. Without it, the LLM improvises the look from the description, which varies between photos |

## Adults only

All characters must be adults. The default system prompt states it explicitly. Creating, editing or importing a
card that states an age under 18, or whose appearance describes a minor, is refused; photos and a voice are
refused for such a card too. See [Security](security.md).

## Chatting in French (or another language)

1. Set `REPLY_LANGUAGE=French` (or ⚙ Settings → reply language). The instruction is added to the system prompt
   **and** repeated right before each reply, because small models tend to drift back to the card's language.
2. For the most natural result, use a card **written in that language**. Models copy the language and style of the
   greeting (`first_mes`) and the example dialogue.

Mistral Nemo-based models (Mistral AI is French) and Qwen models handle French well. Llama 3.1 8B is weaker.

## Lorebooks

Background facts (family, job, places, shared memories) that are only added to her notes when the conversation
mentions them, so long backstories cost nothing until they matter.

In the editor, **Lorebook** → "Add an entry": keywords (comma separated) and what she knows. During the chat, the
last 4 messages are scanned; every entry with a matching keyword (whole word, any case, accents respected) is added
to her notes under `[World info]`, within 15% of the context. "Always included" entries are always there. Keywords
are plain text, never regular expressions. Imported SillyTavern cards keep their lorebook (`character_book`).
