import type Anthropic from '@anthropic-ai/sdk';
import type { PositionState, TokenPrice } from '../graph/client.js';

// El agente es "un LLM con un presupuesto y un trabajo: vigilar una
// posición y avisar si se deteriora". El analista solo observa y resume — la
// decisión de gastar sigue siendo, exclusivamente, decide() en run.ts.
const MODEL = 'claude-opus-5';

// Fallback de servidor ante rechazos, activado explícitamente: la cabecera exacta es "server-side-fallback-2026-07-01",
// y "fallbacks: 'default'" ya tipa sin ampliar nada.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01' as const;

// El producto en pantalla es en inglés —
// el guion de la demo tiene voz en inglés para jurado internacional, así que el panel y el
// analista tienen que hablar el mismo idioma que se ve en cámara. El tipo interno
// AnalystLevel ('ok' | 'vigilar' | 'actuar') no cambia: otro código y otros tests dependen
// de esos valores exactos. Solo cambian las palabras que el modelo ve y produce.
const SYSTEM = [
  "You are the analyst for an agent that watches a liquidity position funded by a bounded,",
  'revocable spending note. Every data query you see was already paid for by a deterministic',
  'rule outside your control: your only job is to read the facts and warn if the position is',
  'deteriorating. You never decide to spend, and you never stop spending — that is not yours.',
  '',
  'Always respond in English. Your first line must start with exactly one of these three',
  'words in capitals — OK, WATCH or ACT — followed by two or three sentences explaining why,',
  'based only on the facts given to you in the message.',
].join('\n');

export type PositionFacts = {
  position: PositionState;
  prices: TokenPrice[];
  spentMicroUsdc: number;
  remainingMicroUsdc: number;
  refusedTools: string[];
};

export type AnalystDeps = {
  create: (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => Promise<Anthropic.Beta.BetaMessage>;
};

export type AnalystLevel = 'ok' | 'vigilar' | 'actuar';

export type AnalystResult = { kind: 'alert'; level: AnalystLevel; summary: string } | { kind: 'refused' };

function parseLevel(text: string): AnalystLevel {
  // Parseo determinista de la primera palabra (sin contar puntuación como ':'):
  // si no es ninguna de las reconocidas, se trata como "vigilar", porque ante
  // la duda se vigila y nunca se da por buena. El prompt en inglés pide
  // OK/WATCH/ACT; ACTUAR/VIGILAR se siguen aceptando (mismo mapeo) para que un
  // texto que todavía las use, o una respuesta vieja en caché, no se rompa.
  const firstWord = text.trim().split(/\s+/)[0]?.replace(/[^\p{L}]/gu, '').toUpperCase() ?? '';
  if (firstWord === 'OK') return 'ok';
  if (firstWord === 'ACT' || firstWord === 'ACTUAR') return 'actuar';
  return 'vigilar';
}

/**
 * El modelo a veces escapa símbolos de Markdown (`\$`, `\*`, `\_`); el panel muestra texto plano,
 * así que se retiran esas barras para que no aparezcan en pantalla.
 */
export function cleanSummary(text: string): string {
  return text
    .trim()
    .replace(/\\([$*_`#~>\[\]()])/g, '$1')
    // El nivel ya se muestra aparte en el panel: se quita del principio para no repetirlo.
    .replace(/^(?:OK|WATCH|ACT|VIGILAR|ACTUAR)\b\s*[—:–-]?\s*/i, '');
}

export async function analyzePosition(deps: AnalystDeps, facts: PositionFacts): Promise<AnalystResult> {
  const response = await deps.create({
    model: MODEL,
    max_tokens: 16_000,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    output_config: { effort: 'low' },
    system: SYSTEM,
    messages: [{ role: 'user', content: JSON.stringify(facts) }],
  });

  // Se comprueba stop_reason === 'refusal' ANTES de leer content: cuando el
  // servidor clasifica la petición como rechazo, el contenido no se toca.
  if (response.stop_reason === 'refusal') {
    return { kind: 'refused' };
  }

  let text = '';
  for (const block of response.content) {
    if (block.type === 'text') text += block.text;
  }

  return { kind: 'alert', level: parseLevel(text), summary: cleanSummary(text) };
}
