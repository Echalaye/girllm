// Splits a streamed reply into speakable sentences as tokens arrive, so
// text-to-speech can start on the first sentence while the model is still
// writing the rest. Pure logic (no DOM): unit-tested in tests/speech.test.ts.

/**
 * Sentence end: . ! ? … (possibly repeated), optional closing quotes or
 * brackets — French typography puts a space before » ("bien ! »") — then
 * whitespace AND the next real character. Waiting for that character
 * avoids cutting "bien ! " before a closing » that hasn't streamed in yet.
 */
const BOUNDARY = /[.!?…]+(?:\s?[»”"')\]])*(?=\s+[^\s»”"')\]])/g;

/** True if `index` falls inside an unclosed *action* (odd number of asterisks before it). */
function insideAction(text, index) {
  let count = 0;
  for (let i = 0; i < index; i++) if (text[i] === '*') count++;
  return count % 2 === 1;
}

export class SentenceSplitter {
  /**
   * @param {{ minChars?: number, maxChars?: number }} [options]
   *   minChars: don't emit tiny fragments ("Oh." is merged with what follows);
   *   maxChars: force a cut (at a comma or space) in very long sentences.
   */
  constructor({ minChars = 20, maxChars = 280 } = {}) {
    this.minChars = minChars;
    this.maxChars = maxChars;
    this.buffer = '';
  }

  /** Feed streamed text; returns the sentences completed so far. */
  push(text) {
    this.buffer += text;
    return this.#drain();
  }

  /** End of stream: returns whatever is left. */
  flush() {
    const out = this.#drain();
    const rest = this.buffer.trim();
    this.buffer = '';
    if (rest) out.push(rest);
    return out;
  }

  #drain() {
    const out = [];
    for (let cut = this.#findCut(); cut > 0; cut = this.#findCut()) {
      const sentence = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut);
      if (sentence) out.push(sentence);
    }
    return out;
  }

  /** Index to cut the buffer at, or -1 if no complete sentence yet. */
  #findCut() {
    const buf = this.buffer;
    // Paragraph breaks are always boundaries.
    const newline = buf.indexOf('\n');
    if (newline >= 0 && buf.slice(0, newline).trim() && !insideAction(buf, newline)) return newline + 1;

    BOUNDARY.lastIndex = 0;
    for (let m = BOUNDARY.exec(buf); m; m = BOUNDARY.exec(buf)) {
      const end = m.index + m[0].length;
      if (end >= this.minChars && !insideAction(buf, end)) return end;
    }

    if (buf.length > this.maxChars) {
      const window = buf.slice(0, this.maxChars);
      const comma = window.lastIndexOf(', ');
      if (comma > this.minChars) return comma + 1;
      const space = window.lastIndexOf(' ');
      return space > 0 ? space : this.maxChars;
    }
    return -1;
  }
}
