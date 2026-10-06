/**
 * Image test bench helpers (scripts/imageBenchLib.ts): run plan, shot
 * selection and the HTML contact sheet (which must escape everything).
 */
import { describe, expect, it } from 'vitest';
import {
  BENCH_SEEDS,
  chooseSeeds,
  escapeHtml,
  planBench,
  renderBenchHtml,
  selectShots,
  SHOTS,
  type BenchModel,
  type BenchResult,
} from '../scripts/imageBenchLib.js';

const model = (checkpoint: string): BenchModel => ({
  checkpoint,
  label: checkpoint,
  sampler: 'euler',
  scheduler: 'normal',
  steps: 20,
  cfg: 5,
});

describe('bench plan', () => {
  it('runs every shot × seed × model, with the same seeds for every model', () => {
    const runs = planBench(SHOTS.slice(0, 2), [model('a'), model('b')], [1, 2]);
    expect(runs).toHaveLength(8);
    expect(runs.slice(0, 2).map((r) => [r.shot.id, r.seed, r.model.checkpoint, r.modelIndex])).toEqual([
      ['portrait', 1, 'a', 0],
      ['portrait', 1, 'b', 1],
    ]);
  });

  it('describes held objects plainly (no hand-centred wording)', () => {
    for (const s of SHOTS) expect(s.scene.realistic).not.toMatch(/both hands|right hand|left hand|fingers/);
  });

  it('has unique shots with SDXL-friendly sizes and both styles', () => {
    expect(new Set(SHOTS.map((s) => s.id)).size).toBe(SHOTS.length);
    for (const s of SHOTS) {
      expect(s.width % 8).toBe(0);
      expect(s.height % 8).toBe(0);
      expect(s.scene.realistic && s.scene.anime).toBeTruthy();
    }
  });

  it('uses the same fixed seeds from one run to the next (4 by default)', () => {
    expect(chooseSeeds({})).toEqual(BENCH_SEEDS.slice(0, 4));
    expect(chooseSeeds({})).toEqual(chooseSeeds({}));
    expect(chooseSeeds({ count: 2 })).toEqual(BENCH_SEEDS.slice(0, 2));
    expect(chooseSeeds({ count: 99 })).toHaveLength(BENCH_SEEDS.length);
    expect(chooseSeeds({ count: 0 })).toHaveLength(1); // clamped to 1–8
    expect(chooseSeeds({ list: ['12', '34'] })).toEqual([12, 34]);
    expect(() => chooseSeeds({ list: ['12', 'abc'] })).toThrow(/Invalid seed "abc"/);
    expect(() => chooseSeeds({ list: ['-1'] })).toThrow(/Invalid seed/);
    expect(() => chooseSeeds({ list: [String(2 ** 47)] })).toThrow(/Invalid seed/);
    expect(new Set(BENCH_SEEDS).size).toBe(BENCH_SEEDS.length);
    expect(BENCH_SEEDS.every((n) => Number.isSafeInteger(n) && n >= 0 && n < 2 ** 47)).toBe(true);
  });

  it('selects shots in the standard order and rejects unknown ones', () => {
    expect(selectShots(undefined)).toHaveLength(SHOTS.length);
    expect(selectShots(['standing', 'selfie']).map((s) => s.id)).toEqual(['selfie', 'standing']);
    expect(() => selectShots(['selfie', 'nope'])).toThrow(/Unknown shot\(s\): nope/);
  });
});

describe('contact sheet', () => {
  it('escapes HTML special characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  it('renders one row per shot and seed, one column per model, escaping untrusted text', () => {
    const models = [model('good.safetensors'), model('<script>alert(1)</script>')];
    const runs = planBench(SHOTS.slice(0, 1), models, [7]);
    const results: BenchResult[] = [
      { ...runs[0]!, file: 'a.png', baseFile: 'a_before.png', seconds: 12.34, detail: 'done' },
      { ...runs[1]!, file: '', seconds: 0, detail: 'failed', error: 'Out of <memory>' },
    ];
    const html = renderBenchHtml({
      title: 'Bench',
      createdAt: 'today',
      style: 'realistic',
      appearance: 'woman & "freckles"',
      models,
      results,
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Out of &lt;memory&gt;');
    expect(html).toContain('woman &amp; &quot;freckles&quot;');
    expect(html).toContain('12.3 s · face redrawn');
    expect(html).toContain('before the face pass');
    expect(html.match(/<tr><th scope="row">/g)).toHaveLength(1);
    expect(html.match(/<th>/g)).toHaveLength(3); // "Shot" + 2 models
  });

  it('explains FLUX.2 results (no face pass)', () => {
    const flux: BenchModel = { ...model('flux2-klein-4b'), family: 'flux2' };
    const [run] = planBench(SHOTS.slice(0, 1), [flux], [1]);
    const html = renderBenchHtml({
      title: 'Bench',
      createdAt: 'today',
      style: 'realistic',
      appearance: 'woman',
      models: [flux],
      results: [{ ...run!, file: 'f.png', seconds: 3, detail: 'flux2' }],
    });
    expect(html).toContain('FLUX.2 (no face pass)');
    expect(html).not.toContain('before the face pass');
  });
});
