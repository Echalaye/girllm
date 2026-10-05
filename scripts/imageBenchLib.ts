/**
 * Pure helpers of the image test bench (scripts/compareImages.ts): the
 * fixed list of test shots, the run plan, and the HTML contact sheet.
 * Unit-tested in tests/imageBench.test.ts.
 */
import type { ArtStyle } from '../src/images/artStyle.js';

export interface Shot {
  id: string;
  /** What it tests, shown on the contact sheet. */
  label: string;
  width: number;
  height: number;
  /** Scene tags per style (photo words vs Danbooru tags). */
  scene: Record<ArtStyle, string>;
}

/**
 * The situations photos actually end up in, from easiest to hardest for
 * SDXL: close faces, small faces, hands, full bodies, unusual poses, low light.
 */
export const SHOTS: readonly Shot[] = [
  {
    id: 'portrait',
    label: 'Close portrait (profile picture)',
    width: 1024,
    height: 1024,
    scene: {
      realistic: 'close-up portrait, looking at the camera, soft smile, window light, plain wall',
      anime: 'portrait, close-up, looking at viewer, smile, simple background',
    },
  },
  {
    id: 'selfie',
    label: 'Waist-up selfie (small face)',
    width: 832,
    height: 1216,
    scene: {
      realistic: 'waist-up selfie, arm extended, smiling, casual sweater, living room, evening lamp light',
      anime: 'selfie, upper body, smile, sweater, living room, indoors, evening, lamp',
    },
  },
  {
    id: 'mirror',
    label: 'Mirror selfie, full body',
    width: 832,
    height: 1216,
    scene: {
      realistic: 'mirror selfie, full body, jeans and t-shirt, bedroom, morning daylight',
      anime: 'mirror selfie, full body, holding phone, jeans, t-shirt, bedroom, morning, sunlight',
    },
  },
  {
    id: 'desk',
    label: 'Sitting at a desk, writing in a notebook',
    width: 832,
    height: 1216,
    scene: {
      // One action for the hands (pen + laptop made the pen merge into the typing hand).
      realistic: 'sitting at a wooden desk, writing in a notebook, blazer, office, daylight',
      anime: 'sitting, desk, writing, notebook, blazer, office, daylight',
    },
  },
  {
    id: 'cup',
    label: 'Holding a cup (hands, fingers)',
    width: 832,
    height: 1216,
    scene: {
      // Plain wording: "with both hands" made big interlaced fingers (bench 2026-10-05).
      realistic: 'waist-up photo, holding a coffee cup, cozy cafe, warm light',
      anime: 'upper body, holding cup, cafe, warm lighting',
    },
  },
  {
    id: 'standing',
    label: 'Full body standing (body proportions)',
    width: 768,
    height: 1344,
    scene: {
      realistic: 'full body photo, standing, summer dress, kitchen, natural light, photo taken by a friend',
      anime: 'full body, standing, sundress, kitchen, indoors, daylight',
    },
  },
  {
    id: 'sofa',
    label: 'Lying on a sofa (unusual pose)',
    width: 1216,
    height: 832,
    scene: {
      realistic: 'lying on a sofa, relaxed, reading a book, pajamas, living room, afternoon light',
      anime: 'lying, on couch, reading, holding book, pajamas, living room, afternoon',
    },
  },
  {
    id: 'outdoor',
    label: 'Outdoors, wide shot',
    width: 1216,
    height: 832,
    scene: {
      realistic: 'wide shot, walking in a city street, coat, autumn leaves, golden hour',
      anime: 'wide shot, walking, city street, coat, autumn leaves, golden hour, outdoors',
    },
  },
  {
    id: 'night',
    label: 'Night, low light',
    width: 832,
    height: 1216,
    scene: {
      realistic: 'night photo, upper body, city lights bokeh behind, neon reflections, dark',
      anime: 'night, upper body, city lights, neon lights, bokeh, dark',
    },
  },
  {
    id: 'back',
    label: 'Seen from behind, looking over the shoulder',
    width: 832,
    height: 1216,
    scene: {
      realistic: 'from behind, looking back over the shoulder, smiling, beach, sunset',
      anime: 'from behind, looking back, smile, beach, sunset, outdoors',
    },
  },
];

/**
 * Fixed seeds: two runs of the bench draw the same pictures, so a change
 * (prompt, setting) is judged on identical cases, not on luck. Hand quality
 * varies a lot from seed to seed: 4 by default.
 */
export const BENCH_SEEDS: readonly number[] = [
  84370200426139, 108282413766794, 87477714402577, 11169854665234, 124853676237104, 137400046219855, 48494237924354,
  31415926535897,
];
export const DEFAULT_SEED_COUNT = 4;
const MAX_SEED = 2 ** 47;

/**
 * Seeds of a run: an explicit list (--seed-list), or the first `count` fixed
 * seeds (--seeds, default 4). Throws on an invalid seed. Pure function.
 */
export function chooseSeeds(o: { count?: number | undefined; list?: readonly string[] | undefined }): number[] {
  if (o.list?.length) {
    return o.list.map((v) => {
      const n = Number(v);
      if (!/^\d+$/.test(v) || !Number.isSafeInteger(n) || n >= MAX_SEED) {
        throw new Error(`Invalid seed "${v}" (a whole number below ${MAX_SEED})`);
      }
      return n;
    });
  }
  const count = Math.max(1, Math.min(BENCH_SEEDS.length, Math.floor(o.count ?? DEFAULT_SEED_COUNT)));
  return BENCH_SEEDS.slice(0, count);
}

export interface BenchModel {
  checkpoint: string;
  /** Preset name, or "your settings". */
  label: string;
  sampler: string;
  scheduler: string;
  steps: number;
  cfg: number;
  /** Graph family; default SDXL (one checkpoint file). */
  family?: 'sdxl' | 'flux2';
}

export interface BenchRun {
  shot: Shot;
  model: BenchModel;
  modelIndex: number;
  seed: number;
}

/** Every (shot, model, seed) combination; the same seeds for every model (fair comparison). */
export function planBench(shots: readonly Shot[], models: readonly BenchModel[], seeds: readonly number[]): BenchRun[] {
  const runs: BenchRun[] = [];
  for (const shot of shots) {
    for (const seed of seeds) {
      models.forEach((model, modelIndex) => runs.push({ shot, model, modelIndex, seed }));
    }
  }
  return runs;
}

/** Shots selected on the command line ("--shots selfie,standing"), in the standard order. */
export function selectShots(ids: readonly string[] | undefined): Shot[] {
  if (!ids?.length) return [...SHOTS];
  const unknown = ids.filter((id) => !SHOTS.some((s) => s.id === id));
  if (unknown.length) {
    throw new Error(`Unknown shot(s): ${unknown.join(', ')}. Known: ${SHOTS.map((s) => s.id).join(', ')}`);
  }
  return SHOTS.filter((s) => ids.includes(s.id));
}

export interface BenchResult extends BenchRun {
  /** File names relative to the contact sheet. */
  file: string;
  baseFile?: string | undefined;
  seconds: number;
  detail: string;
  error?: string | undefined;
}

export interface BenchSheet {
  title: string;
  createdAt: string;
  style: ArtStyle;
  appearance: string;
  models: readonly BenchModel[];
  results: readonly BenchResult[];
}

/** Escape text for HTML (prompts and model names are not trusted markup). */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const DETAIL_LABELS: Record<string, string> = {
  done: 'face redrawn',
  'close-up': 'close-up, no face pass',
  'no-face': 'no face found',
  'no-detector': 'face detector not installed',
  off: 'face pass off',
  failed: 'face pass failed',
  flux2: 'FLUX.2 (no face pass)',
  'flux2-pose': 'FLUX.2 with pose guide',
  'flux2-no-pose': 'FLUX.2, no pose guide for this shot',
};

/**
 * Self-contained contact sheet (no script, no external resources): one row
 * per shot and seed, one column per model; the picture before the face pass
 * is behind a "before" disclosure.
 */
export function renderBenchHtml(sheet: BenchSheet): string {
  const e = escapeHtml;
  const head = sheet.models
    .map(
      (m) =>
        `<th>${e(m.label)}<br><small>${e(m.checkpoint)}<br>${e(`${m.sampler} · ${m.scheduler} · ${m.steps} steps · CFG ${m.cfg}`)}</small></th>`,
    )
    .join('');
  const rows = new Map<string, BenchResult[]>();
  for (const r of sheet.results) {
    const key = `${r.shot.id}#${r.seed}`;
    rows.set(key, [...(rows.get(key) ?? []), r]);
  }
  const body = [...rows.values()]
    .map((cells) => {
      const { shot, seed } = cells[0]!;
      const tds = sheet.models
        .map((_, i) => {
          const r = cells.find((c) => c.modelIndex === i);
          if (!r) return '<td></td>';
          if (r.error) return `<td class="error">${e(r.error)}</td>`;
          const before =
            r.baseFile && r.baseFile !== r.file
              ? `<details><summary>before the face pass</summary><a href="${e(r.baseFile)}"><img src="${e(r.baseFile)}" alt="before"></a></details>`
              : '';
          return `<td><a href="${e(r.file)}"><img src="${e(r.file)}" alt="${e(shot.label)}" loading="lazy"></a><p>${r.seconds.toFixed(1)} s · ${e(DETAIL_LABELS[r.detail] ?? r.detail)}</p>${before}</td>`;
        })
        .join('');
      return `<tr><th scope="row">${e(shot.label)}<br><small>seed ${seed}<br>${e(shot.scene[sheet.style])}</small></th>${tds}</tr>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(sheet.title)}</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 1.5rem; background: #191a2e; color: #eeebf7; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  p.meta { color: #a19ec6; margin: 0 0 1rem; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #3a3b5e; padding: .5rem; vertical-align: top; text-align: left; }
  th[scope="row"] { width: 13rem; }
  small { color: #a19ec6; font-weight: 400; }
  img { display: block; max-width: 22rem; max-height: 30rem; border-radius: 6px; }
  details img { max-width: 11rem; margin-top: .25rem; }
  td p { margin: .3rem 0 0; color: #a19ec6; }
  td.error { color: #ff8a80; max-width: 20rem; }
</style>
</head>
<body>
<h1>${e(sheet.title)}</h1>
<p class="meta">${e(sheet.createdAt)} · ${e(sheet.style)} · appearance: ${e(sheet.appearance)}</p>
<table>
<thead><tr><th>Shot</th>${head}</tr></thead>
<tbody>
${body}
</tbody>
</table>
</body>
</html>
`;
}
