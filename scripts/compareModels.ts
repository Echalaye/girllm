/**
 * Compare chat models on the same realistic conversations, through girllm's
 * real prompt builder (character card, memories, time awareness, reminders).
 *
 *   npm run compare -- <model> [<model> …] [--character magi] [--runs 2]
 *
 * Without --character, the first character of the list is used.
 *
 * Writes a Markdown report to DATA_DIR/model-comparison-<date>.md with every
 * reply, speed figures and automatic checks (language, length, assistant-isms,
 * speaking for the user). Read the replies: the checks only flag problems,
 * they don't measure charm.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CharacterRepository } from '../src/characters/characterRepository.js';
import { loadConfig } from '../src/config.js';
import { createLlmProvider } from '../src/llm/createProvider.js';
import type { LlmProvider } from '../src/llm/types.js';
import { buildPrompt, stopSequencesFor } from '../src/prompt/promptBuilder.js';
import { cell, checkReply, SCENARIOS_FR, type ReplyCheck } from './compareLib.js';

interface Result {
  model: string;
  scenario: string;
  run: number;
  reply: string;
  firstTokenMs: number;
  totalMs: number;
  check: ReplyCheck;
}

function parseArgs(argv: string[]) {
  const models: string[] = [];
  /** Character id; undefined = the first one of the list. */
  let character: string | undefined;
  let runs = 1;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--character') character = argv[++i] ?? character;
    else if (arg === '--runs') runs = Math.max(1, Math.min(5, Number(argv[++i]) || 1));
    else models.push(arg);
  }
  return { models, character, runs };
}

async function timedReply(
  llm: LlmProvider,
  messages: Parameters<LlmProvider['streamChat']>[0],
  opts: Parameters<LlmProvider['streamChat']>[1],
) {
  const start = performance.now();
  let first = 0;
  let text = '';
  for await (const delta of llm.streamChat(messages, opts)) {
    if (!first) first = performance.now();
    text += delta;
  }
  const end = performance.now();
  return { text: text.trim(), firstTokenMs: Math.round((first || end) - start), totalMs: Math.round(end - start) };
}

async function main(): Promise<void> {
  const { models, character: characterId, runs } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  if (models.length === 0) models.push(config.llm.model);

  const characters = await CharacterRepository.loadFromDirectory(config.charactersDir, {
    info: () => undefined,
    warn: (m) => {
      console.warn(m);
    },
  });
  const character = characterId ? characters.get(characterId) : characters.list()[0];
  if (!character)
    throw new Error(
      `Character "${characterId ?? '(any)'}" not found (ids: ${characters
        .list()
        .map((c) => c.id)
        .join(', ')})`,
    );

  const { contextTokens, maxReplyTokens, temperature, topP, minP, repeatPenalty } = config.generation;
  const results: Result[] = [];

  for (const model of models) {
    const llm = createLlmProvider({ ...config, llm: { ...config.llm, model } });
    console.log(`\n▶ ${model}: loading…`);
    const warm = await timedReply(llm, [{ role: 'user', content: 'Bonjour' }], {
      maxTokens: 1,
      temperature: 0,
      topP: 1,
    });
    console.log(`  loaded in ${(warm.totalMs / 1000).toFixed(1)} s`);

    for (const scenario of SCENARIOS_FR) {
      for (let run = 1; run <= runs; run++) {
        const now = new Date();
        const prompt = buildPrompt(
          character,
          scenario.history,
          config.userName,
          { contextTokens, maxReplyTokens },
          {
            replyLanguage: config.replyLanguage,
            memory: { summary: '', memories: scenario.memories ?? [], mood: '' },
            time: { now, previousMessageAt: new Date(now.getTime() - (scenario.pauseMs ?? 5 * 60_000)) },
          },
        );
        const r = await timedReply(llm, prompt.messages, {
          maxTokens: maxReplyTokens,
          temperature,
          topP,
          minP,
          repeatPenalty,
          stop: stopSequencesFor(config.userName),
        });
        const check = checkReply(r.text, config.userName);
        results.push({
          model,
          scenario: scenario.id,
          run,
          reply: r.text,
          firstTokenMs: r.firstTokenMs,
          totalMs: r.totalMs,
          check,
        });
        const flags = [
          check.assistantIsms.length ? 'assistant-ism' : '',
          check.speaksForUser ? 'speaks for you' : '',
          check.french < 0.7 ? 'not French' : '',
        ]
          .filter(Boolean)
          .join(', ');
        console.log(`  ${scenario.id.padEnd(9)} ${String(r.totalMs).padStart(6)} ms  ${flags || 'ok'}`);
      }
    }
  }

  // ---- Report -------------------------------------------------------------
  const lines: string[] = [
    `# Model comparison — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    '',
    `Character: **${character.name}** (${character.style}) · language: ${config.replyLanguage ?? 'auto'} · ` +
      `temperature ${temperature}, top_p ${topP}, min_p ${minP}, repeat_penalty ${repeatPenalty} · ${runs} run(s) per scenario`,
    '',
    '## Summary',
    '',
    '| Model | Avg first token | Avg reply time | Avg length (chars) | Assistant-isms | Speaks for you | Not French |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const model of models) {
    const rs = results.filter((r) => r.model === model);
    const avg = (f: (r: Result) => number) => Math.round(rs.reduce((s, r) => s + f(r), 0) / rs.length);
    lines.push(
      `| ${model} | ${avg((r) => r.firstTokenMs)} ms | ${avg((r) => r.totalMs)} ms | ${avg((r) => r.check.chars)} | ` +
        `${rs.filter((r) => r.check.assistantIsms.length).length}/${rs.length} | ${rs.filter((r) => r.check.speaksForUser).length}/${rs.length} | ` +
        `${rs.filter((r) => r.check.french < 0.7).length}/${rs.length} |`,
    );
  }
  for (const scenario of SCENARIOS_FR) {
    lines.push(
      '',
      `## ${scenario.id}: ${scenario.goal}`,
      '',
      `> **${config.userName}:** ${cell(scenario.history.at(-1)!.content)}`,
      '',
    );
    lines.push('| Model | Reply | Time | Flags |', '|---|---|---|---|');
    for (const r of results.filter((x) => x.scenario === scenario.id)) {
      const flags = [
        ...r.check.assistantIsms.map(() => 'assistant-ism'),
        r.check.speaksForUser ? 'speaks for you' : '',
        r.check.french < 0.7 ? 'not French' : '',
      ]
        .filter(Boolean)
        .join(', ');
      lines.push(
        `| ${r.model}${runs > 1 ? ` #${r.run}` : ''} | ${cell(r.reply)} | ${r.totalMs} ms | ${flags || '—'} |`,
      );
    }
  }

  const dataDir = resolve(config.databasePath, '..');
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, `model-comparison-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`);
  writeFileSync(file, `${lines.join('\n')}\n`);
  console.log(`\nReport: ${file}`);
}

main().catch((err: unknown) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
