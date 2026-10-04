/**
 * "She sends photos on her own" (step 4d).
 *
 * The model is told it may end a message with `[photo: what the photo
 * shows]`. That tag must never reach the screen or the database: the
 * streaming filter below removes it on the fly (holding back the few
 * characters that *might* start a tag) and captures its description.
 *
 * Pure logic, unit-tested in tests/photoTag.test.ts.
 */

/** Words accepted as the tag name ("[photo: …]", "[selfie: …]", "[Photo : …]"). */
const TAG_NAMES = ['photo', 'selfie'] as const;
/** A description longer than this isn't a tag (or is garbage): shown as text. */
const MAX_TAG_CHARS = 300;

export class PhotoTagFilter {
  /** Text held back because it may be the start of a tag. */
  private pending = '';
  private captured: string | undefined;

  /** Description of the first photo tag found, if any. */
  get photo(): string | undefined {
    return this.captured;
  }

  /** Feed a streamed chunk; returns the text that can be shown now. */
  push(chunk: string): string {
    this.pending += chunk;
    return this.drain(false);
  }

  /** End of stream: returns whatever is left (an unfinished tag is still captured and hidden). */
  end(): string {
    return this.drain(true);
  }

  private drain(final: boolean): string {
    let out = '';
    for (;;) {
      const open = this.pending.indexOf('[');
      if (open < 0) {
        out += this.pending;
        this.pending = '';
        return out;
      }
      out += this.pending.slice(0, open);
      this.pending = this.pending.slice(open);

      const match = /^\[\s*(photo|selfie)\s*:\s*([^\]\n]*)\]/i.exec(this.pending);
      if (match) {
        this.capture(match[2] ?? '');
        this.pending = this.pending.slice(match[0].length);
        continue;
      }
      if (this.couldBeTag(this.pending)) {
        if (!final) return out; // wait for more text
        // Stream ended inside "[photo: …": keep the description, hide the tag.
        const unfinished = /^\[\s*(?:photo|selfie)\s*:\s*(.*)$/is.exec(this.pending);
        if (unfinished) this.capture(unfinished[1] ?? '');
        else out += this.pending;
        this.pending = '';
        return out;
      }
      // A normal "[": show it and keep scanning after it.
      out += '[';
      this.pending = this.pending.slice(1);
    }
  }

  /** Is `text` (starting with "[") a possible beginning of a photo tag? */
  private couldBeTag(text: string): boolean {
    if (text.includes(']') || text.includes('\n') || text.length > MAX_TAG_CHARS) return false;
    const rest = text.slice(1).trimStart().toLowerCase();
    return TAG_NAMES.some((name) => {
      if (name.startsWith(rest)) return true; // still typing the name: "[pho"
      if (!rest.startsWith(name)) return false;
      return /^\s*(:.*)?$/s.test(rest.slice(name.length)); // "[photo", "[photo :", "[photo: a sel"
    });
  }

  private capture(description: string): void {
    const clean = description.replace(/\s+/g, ' ').trim();
    if (clean && this.captured === undefined) this.captured = clean;
  }
}

/** Remove any photo tag from finished text (e.g. a regenerated or stored message). */
export function stripPhotoTags(text: string): { text: string; photo: string | undefined } {
  const filter = new PhotoTagFilter();
  const visible = filter.push(text) + filter.end();
  return { text: visible, photo: filter.photo };
}

/**
 * Does the user's message ask her for a photo? ("envoie-moi une photo",
 * "tu me montres ta tenue ?", "send me a selfie"…). It only lifts the
 * cooldown and adds a hint: she may still say no, in character.
 */
export function asksForPhoto(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b(selfie|pic|pics|picture|snap)\b/.test(t)) return true;
  return /\b(envoie|envoies|envoyer|envoyez|montre|montres|montrer|send|show)\b[^.?!\n]{0,40}\b(photo|photos|tof|toi|ta tenue|your outfit|yourself)\b/.test(
    t,
  );
}

/** Her messages that must separate two spontaneous photos. */
export const PHOTO_COOLDOWN = { rare: 12, often: 5 } as const;

/** How many of her messages since the last photo she sent (Infinity if none). */
export function messagesSinceLastPhoto(messages: ReadonlyArray<{ role: string; imageId: string | null }>): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.imageId) return count;
    if (m.role === 'assistant') count++;
  }
  return Number.POSITIVE_INFINITY;
}
