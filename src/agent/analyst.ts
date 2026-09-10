import type Anthropic from '@anthropic-ai/sdk';
import type { PositionState, TokenPrice } from '../graph/client.js';

// El agente es "un LLM con un presupuesto y un trabajo: vigilar una
// posición y avisar si se deteriora". El analista solo observa y resume — la
// decisión de gastar sigue siendo, exclusivamente, decide() en run.ts.
const MODEL = 'claude-opus-5';

// Fallback de servidor ante rechazos, activado explícitamente: la cabecera exacta es "server-side-fallback-2026-07-01",
// y "fallbacks: 'default'" ya tipa sin ampliar nada.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01' as const;

const SYSTEM = [
  'Eres el analista de un agente que vigila una posición de liquidez financiada por una',
  'paga (spending note) acotada y revocable. Cada consulta de datos que ves ya fue pagada',
  'por una regla determinista ajena a ti: tu trabajo es solo leer los hechos y avisar si la',
  'posición se está deteriorando. Nunca decides gastar ni frenas el gasto: eso no es tuyo.',
  '',
  'Responde siempre en español. Tu primera línea debe empezar exactamente por una de estas',
  'tres palabras en mayúsculas — OK, VIGILAR o ACTUAR — seguida de dos o tres frases que',
  'expliquen por qué, en base solo a los hechos que se te dan en el mensaje.',
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
  // si no es ninguna de las tres, se trata como "vigilar", porque ante la duda
  // se vigila y nunca se da por buena.
  const firstWord = text.trim().split(/\s+/)[0]?.replace(/[^\p{L}]/gu, '').toUpperCase() ?? '';
  if (firstWord === 'OK') return 'ok';
  if (firstWord === 'ACTUAR') return 'actuar';
  return 'vigilar';
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

  return { kind: 'alert', level: parseLevel(text), summary: text.trim() };
}
