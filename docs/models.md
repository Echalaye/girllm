# Choosing a chat model (8 GB VRAM)

12B models in 4-bit are the sweet spot for 8 GB. Candidates worth comparing:

| Model                               | Pull command                                                 | Notes                                                                       |
| ----------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Mistral Nemo 12B Instruct           | `ollama pull mistral-nemo:12b-instruct-2407-q4_K_M`          | Good French (Mistral AI is French). General-purpose, a bit "assistant-like" |
| Mag-Mell R1 (Nemo 12B fine-tune)    | `ollama pull hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:IQ4_XS` | Roleplay/creative fine-tune: more personality. Check its French             |
| Rocinante v1.1 (Nemo 12B fine-tune) | `ollama pull hf.co/bartowski/Rocinante-12B-v1.1-GGUF:IQ4_XS` | Roleplay/creative fine-tune. Check its French                               |

`IQ4_XS` (~6.7 GB) leaves more room for the context than `Q4_K_M` (7.5 GB) with almost the same quality.

## Compare them on your own conversations

Roleplay fine-tunes are mostly trained on English, so their French can be weaker than the base model's. Don't
guess, compare:

```powershell
npm run compare -- mistral-nemo:12b-instruct-2407-q4_K_M hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:IQ4_XS
```

The script runs the same French conversations through each model (with the first character of `characters/` by
default) and writes a report in `data\model-comparison-….md`: every reply side by side, the speed, and automatic
flags (assistant-like phrases, writing your lines, not French). Read the replies themselves: the flags catch
problems, not charm. Then set the winner in `LLM_MODEL` (or pick it in ⚙ Settings).

## Sampling

`TEMPERATURE=0.7` and `MIN_P=0.05` are good defaults. Go up to `0.8`–`0.9` for more surprise, and down to `0.6`
if she loses the thread. `REPEAT_PENALTY=1.1` discourages repeating the same words.

## Safety of downloaded models

Only download **`.gguf`** / **`.safetensors`** files, never pickle (`.bin`, `.pt`) files from unknown sources: a
pickle file can run code when it is loaded.

## VRAM budget

The chat model, its context and the embedding model (~0.6 GB, for memory) share the 8 GB. Photos and her voice
unload the chat model while they run (see [Photos](photos.md)), so they don't need extra room. If replies are slow
or `ollama ps` shows a CPU/GPU split, see
[Check the model is really on the GPU](installation.md#check-the-model-is-really-on-the-gpu).
