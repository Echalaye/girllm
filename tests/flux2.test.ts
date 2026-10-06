/**
 * FLUX.2 [klein] 4B in the image test bench (step 6b): workflow graph,
 * pinned downloads and ComfyUI support detection.
 */
import { describe, expect, it } from 'vitest';
import { ComfyClient } from '../src/images/comfyClient.js';
import {
  buildFlux2Prompt,
  buildFlux2Workflow,
  FLUX2_KLEIN_FILES,
  FLUX2_KLEIN_MODEL,
  flux2Variant,
  FLUX2_DEFAULT_VARIANTS,
  FLUX2_POSE_HINT,
  FLUX2_KLEIN_BASE_FILES,
  FLUX2_KLEIN_BASE_MODEL,
  FLUX2_NEGATIVE,
  FLUX2_VARIANTS,
  FLUX2_KLEIN_TEXT_ENCODER,
  FLUX2_PHOTO_STYLE,
  FLUX2_REFERENCE_HINT,
  FLUX2_VAE,
  multipleOf16,
  referenceCrop,
} from '../src/images/flux2Workflow.js';
import { assertSafe } from '../src/images/safety.js';

const base = {
  positive: 'adult, woman, full body photo',
  seed: 123,
  width: 768,
  height: 1344,
  sampler: 'euler',
  steps: 4,
  cfg: 1,
};

/** Every node input that links to another node must point at an existing node. */
function danglingLinks(wf: ReturnType<typeof buildFlux2Workflow>): string[] {
  return Object.entries(wf).flatMap(([id, node]) =>
    Object.values(node.inputs)
      .filter((v): v is [string, number] => Array.isArray(v) && typeof v[0] === 'string')
      .filter(([target]) => !(target in wf))
      .map(([target]) => `${id} → ${target}`),
  );
}

describe('FLUX.2 [klein] workflow', () => {
  it('follows the official distilled template: 3 loaders, zeroed negative, CFG 1, 4 steps', () => {
    const wf = buildFlux2Workflow(base);
    expect(wf['1']!.inputs).toEqual({ unet_name: FLUX2_KLEIN_MODEL.file, weight_dtype: 'default' });
    expect(wf['2']!.inputs).toEqual({ clip_name: FLUX2_KLEIN_TEXT_ENCODER.file, type: 'flux2', device: 'default' });
    expect(wf['3']!.inputs).toEqual({ vae_name: FLUX2_VAE.file });
    expect(wf['5']).toMatchObject({ class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } });
    expect(wf['11']!.inputs).toMatchObject({ positive: ['4', 0], negative: ['5', 0], cfg: 1 });
    expect(wf['8']!.inputs).toEqual({ steps: 4, width: 768, height: 1344 });
    expect(wf['6']!.inputs).toEqual({ width: 768, height: 1344, batch_size: 1 });
    expect(wf['9']!.inputs).toEqual({ sampler_name: 'euler' });
    expect(wf['10']!.inputs).toEqual({ noise_seed: 123 });
    expect(wf['4']!.inputs.text).toBe(base.positive);
    expect(wf['20']).toBeUndefined();
    expect(danglingLinks(wf)).toEqual([]);
    // Core ComfyUI nodes only: no custom node pack needed.
    expect(Object.values(wf).some((n) => /IPAdapter|GGUF/.test(n.class_type))).toBe(false);
  });

  it('attaches her face as a reference picture to both conditionings', () => {
    const wf = buildFlux2Workflow({ ...base, referenceImage: 'girllm_bench_face.png' });
    expect(wf['20']!.inputs).toEqual({ image: 'girllm_bench_face.png' });
    expect(wf['22']).toMatchObject({ class_type: 'VAEEncode', inputs: { pixels: ['21', 0], vae: ['3', 0] } });
    expect(wf['23']!.inputs).toEqual({ conditioning: ['4', 0], latent: ['22', 0] });
    expect(wf['24']!.inputs).toEqual({ conditioning: ['5', 0], latent: ['22', 0] });
    expect(wf['11']!.inputs).toMatchObject({ positive: ['23', 0], negative: ['24', 0] });
    expect(wf['4']!.inputs.text).toBe(base.positive); // the prompt builder adds the face sentence
    expect(wf['25']).toBeUndefined();
    expect(danglingLinks(wf)).toEqual([]);
  });

  it('crops the reference picture to her face when asked', () => {
    const crop = { x: 100, y: 50, width: 400, height: 400 };
    const wf = buildFlux2Workflow({ ...base, referenceImage: 'face.png', referenceCrop: crop });
    expect(wf['25']).toEqual({ class_type: 'ImageCrop', inputs: { image: ['20', 0], ...crop } });
    expect(wf['21']!.inputs.image).toEqual(['25', 0]);
    expect(danglingLinks(wf)).toEqual([]);
  });

  it('encodes a real negative prompt for the base model', () => {
    const wf = buildFlux2Workflow({
      ...base,
      steps: 20,
      cfg: 5,
      negative: 'bad hands',
      files: { model: FLUX2_KLEIN_BASE_MODEL.file, textEncoder: FLUX2_KLEIN_TEXT_ENCODER.file, vae: FLUX2_VAE.file },
      referenceImage: 'face.png',
    });
    expect(wf['5']).toEqual({ class_type: 'CLIPTextEncode', inputs: { text: 'bad hands', clip: ['2', 0] } });
    expect(wf['1']!.inputs.unet_name).toBe(FLUX2_KLEIN_BASE_MODEL.file);
    expect(wf['11']!.inputs).toMatchObject({ cfg: 5, negative: ['24', 0] });
    expect(wf['24']!.inputs.conditioning).toEqual(['5', 0]);
    expect(danglingLinks(wf)).toEqual([]);
  });

  it('adds the pose guide as a second reference, after her face', () => {
    const wf = buildFlux2Workflow({ ...base, steps: 8, referenceImage: 'face.png', poseImage: 'pose.png' });
    expect(wf['50']!.inputs).toEqual({ image: 'pose.png' });
    expect(wf['52']!.inputs).toEqual({ pixels: ['51', 0], vae: ['3', 0] });
    // Chained after the face references (23/24): face = image 1, pose = image 2.
    expect(wf['53']!.inputs).toEqual({ conditioning: ['23', 0], latent: ['52', 0] });
    expect(wf['54']!.inputs).toEqual({ conditioning: ['24', 0], latent: ['52', 0] });
    expect(wf['11']!.inputs).toMatchObject({ positive: ['53', 0], negative: ['54', 0] });
    expect(danglingLinks(wf)).toEqual([]);
    // Without her face the numbering would be wrong: no pose guide then.
    expect(buildFlux2Workflow({ ...base, poseImage: 'pose.png' })['50']).toBeUndefined();
    expect(buildFlux2Workflow({ ...base, referenceImage: 'face.png' })['50']).toBeUndefined();
  });

  it('rounds sizes to multiples of 16 (FLUX.2 latent cells)', () => {
    expect(multipleOf16(832)).toBe(832);
    expect(multipleOf16(1000)).toBe(1008);
    expect(multipleOf16(3)).toBe(16);
    const wf = buildFlux2Workflow({ ...base, width: 1000, height: 1210 });
    expect(wf['6']!.inputs).toMatchObject({ width: 1008, height: 1216 });
  });

  it('has bench variants with the official settings, only the base one with a negative prompt', () => {
    expect(new Set(FLUX2_VARIANTS.map((v) => v.id)).size).toBe(FLUX2_VARIANTS.length);
    expect(flux2Variant('flux2-klein-4b')).toMatchObject({ steps: 4, cfg: 1, negative: false, reference: true });
    expect(flux2Variant('flux2-klein-4b-noref')?.reference).toBe(false);
    expect(flux2Variant('flux2-klein-4b-base')).toMatchObject({
      model: FLUX2_KLEIN_BASE_MODEL,
      steps: 20,
      cfg: 5,
      negative: true,
    });
    expect(FLUX2_VARIANTS.filter((v) => v.negative).every((v) => v.cfg > 1)).toBe(true);
    expect(flux2Variant('nope')).toBeUndefined();
    expect(flux2Variant('flux2-klein-4b-8steps-pose')).toMatchObject({ steps: 8, pose: true, reference: true });
    expect(FLUX2_VARIANTS.filter((v) => v.pose).map((v) => v.id)).toEqual(['flux2-klein-4b-8steps-pose']);
    expect(FLUX2_DEFAULT_VARIANTS).toEqual(['flux2-klein-4b-8steps', 'flux2-klein-4b-8steps-pose']);
    expect(FLUX2_DEFAULT_VARIANTS.every((id) => flux2Variant(id))).toBe(true);
    expect(FLUX2_NEGATIVE).toMatch(/extra fingers.*extra legs/);
  });

  it('pins its downloads to a Hugging Face commit and a SHA-256', () => {
    expect(FLUX2_KLEIN_FILES).toHaveLength(3);
    expect(FLUX2_KLEIN_BASE_FILES.slice(1)).toEqual(FLUX2_KLEIN_FILES.slice(1)); // same encoder and VAE
    for (const f of [...FLUX2_KLEIN_FILES, FLUX2_KLEIN_BASE_MODEL]) {
      expect(f.url).toMatch(/^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/[0-9a-f]{40}\//);
      expect(f.url.endsWith(f.file)).toBe(true);
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('FLUX.2 prompt', () => {
  const parts = {
    style: 'realistic' as const,
    gender: 'female' as const,
    appearance: 'woman, 23 years old, long wavy chestnut hair.',
    scene: 'lying on a sofa, reading a book, pajamas',
    reference: false,
  };

  it('puts the scene first, in sentences, with an adult subject and no phone-inducing words', () => {
    const text = buildFlux2Prompt(parts);
    expect(text).toBe(
      'A candid photo of an adult woman. Scene: lying on a sofa, reading a book, pajamas. ' +
        `She looks like this: woman, 23 years old, long wavy chestnut hair. ${FLUX2_PHOTO_STYLE}`,
    );
    // The "correct hands" sentence changed nothing on the bench: removed.
    expect(text).not.toMatch(/finger/i);
    expect(text).not.toMatch(/smartphone|phone/i);
    expect(text).not.toMatch(/\.\./);
    expect(() => {
      assertSafe(text);
    }).not.toThrow();
  });

  it('asks for her face only from the reference picture, with the right pronouns', () => {
    expect(buildFlux2Prompt({ ...parts, reference: true })).toContain(FLUX2_REFERENCE_HINT);
    const him = buildFlux2Prompt({ ...parts, gender: 'male', reference: true, appearance: 'man, 30' });
    expect(him).toMatch(/^A candid photo of an adult man\./);
    expect(him).toContain('He looks like this: man, 30.');
    expect(him).toContain('His face is exactly the face of the person in image 1');
    expect(buildFlux2Prompt({ ...parts, style: 'anime' })).toMatch(/^An anime illustration of an adult woman/);
    expect(buildFlux2Prompt({ ...parts, style: 'anime' })).not.toContain(FLUX2_PHOTO_STYLE);
  });

  it('asks for the pose only from the pose guide (image 2), after the face sentence', () => {
    const text = buildFlux2Prompt({ ...parts, reference: true, pose: true });
    expect(text.indexOf(FLUX2_REFERENCE_HINT)).toBeLessThan(text.indexOf(FLUX2_POSE_HINT));
    expect(FLUX2_POSE_HINT).toMatch(/image 2.*not the face/);
    expect(buildFlux2Prompt({ ...parts, gender: 'male', reference: true, pose: true })).toContain('His pose');
    expect(buildFlux2Prompt(parts)).not.toContain('image 2');
    expect(() => {
      assertSafe(text);
    }).not.toThrow();
  });
});

describe('reference face crop', () => {
  it('keeps a square around the face (×1.3), inside the picture', () => {
    expect(referenceCrop({ x: 400, y: 300, width: 200, height: 250, score: 1 }, 1024, 1024)).toEqual({
      x: 338,
      y: 263,
      width: 325,
      height: 325,
    });
    // A head-and-shoulders portrait (Magi's: face box 472×544 in 1024²) loses most of the clothes and background.
    expect(referenceCrop({ x: 214, y: 190, width: 472, height: 544, score: 1 }, 1024, 1024)).toEqual({
      x: 97,
      y: 109,
      width: 707,
      height: 707,
    });
    const edge = referenceCrop({ x: 0, y: 0, width: 300, height: 300, score: 1 }, 1024, 768);
    expect(edge).toEqual({ x: 0, y: 0, width: 390, height: 390 });
    const huge = referenceCrop({ x: 0, y: 0, width: 700, height: 700, score: 1 }, 1024, 768);
    expect(huge.width).toBe(768);
    expect(huge.x + huge.width).toBeLessThanOrEqual(1024);
  });
});

describe('ComfyClient FLUX.2 support', () => {
  /** Minimal /object_info answers: which nodes exist and which files they list. */
  function fakeComfy(nodes: Record<string, Record<string, string[]>>) {
    const fetchImpl = (async (input: string | URL) => {
      const name = decodeURIComponent(new URL(String(input)).pathname.replace('/object_info/', ''));
      const inputs = nodes[name];
      const required = Object.fromEntries(Object.entries(inputs ?? {}).map(([k, files]) => [k, [files]]));
      return new Response(JSON.stringify(inputs ? { [name]: { input: { required } } } : {}));
    }) as typeof fetch;
    return new ComfyClient({ baseUrl: 'http://comfy', fetchImpl });
  }
  const files = { model: FLUX2_KLEIN_MODEL.file, textEncoder: FLUX2_KLEIN_TEXT_ENCODER.file, vae: FLUX2_VAE.file };
  const recent = { EmptyFlux2LatentImage: {}, ReferenceLatent: {} };

  it('is ready with a recent ComfyUI and the three files', async () => {
    const comfy = fakeComfy({
      ...recent,
      UNETLoader: { unet_name: [files.model] },
      CLIPLoader: { clip_name: ['clip_l.safetensors', files.textEncoder] },
      VAELoader: { vae_name: [files.vae] },
    });
    expect(await comfy.flux2Support(files)).toEqual({ ready: true });
    expect(await comfy.modelFiles('UNETLoader', 'unet_name')).toEqual([files.model]);
  });

  it('says to update an old ComfyUI', async () => {
    const comfy = fakeComfy({ UNETLoader: { unet_name: [files.model] } });
    expect((await comfy.flux2Support(files)).reason).toMatch(/update ComfyUI/);
  });

  it('says which file is missing and how to install it', async () => {
    const comfy = fakeComfy({
      ...recent,
      UNETLoader: { unet_name: [files.model] },
      CLIPLoader: { clip_name: [] },
      VAELoader: { vae_name: [files.vae] },
    });
    const support = await comfy.flux2Support(files);
    expect(support.ready).toBe(false);
    expect(support.reason).toBe(`${files.textEncoder} not found (run: npm run setup:images -- --flux2-klein)`);
  });

  it('lists nothing when a node is unknown or ComfyUI is down', async () => {
    expect(await fakeComfy({}).modelFiles('UNETLoader', 'unet_name')).toEqual([]);
    const down = new ComfyClient({
      baseUrl: 'http://comfy',
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(await down.modelFiles('UNETLoader', 'unet_name')).toEqual([]);
  });
});
