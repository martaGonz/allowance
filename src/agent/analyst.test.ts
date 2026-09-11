import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { analyzePosition, type AnalystDeps, type PositionFacts, cleanSummary } from './analyst.js';

const FACTS: PositionFacts = {
  position: { positionId: 'p1', liquidity: '1000', liquidityUsd: '2000', token0: '0xa', token1: '0xb', closed: false },
  prices: [{ contract: '0xa', priceUsd: 1.5, asOf: 1_757_000_000_000 }],
  spentMicroUsdc: 14_000,
  remainingMicroUsdc: 86_000,
  refusedTools: [],
};

/**
 * Construye un `BetaMessage` mínimo con un único bloque de texto. El resto de
 * campos son los que exige el tipo, pero al analista solo le importan
 * `stop_reason` y `content`.
 */
function textMessage(text: string, stopReason: Anthropic.Beta.BetaStopReason = 'end_turn'): Anthropic.Beta.BetaMessage {
  return {
    id: 'msg_1',
    container: null,
    content: [{ type: 'text', text, citations: null }],
    context_management: null,
    diagnostics: null,
    model: 'claude-opus-5',
    role: 'assistant',
    stop_details: null,
    stop_reason: stopReason,
    stop_sequence: null,
    type: 'message',
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      server_tool_use: null,
      service_tier: null,
    },
    input_transformations: [],
  } as unknown as Anthropic.Beta.BetaMessage;
}

describe('cleanSummary', () => {
  it('quita las barras de escape de Markdown sin tocar el resto', () => {
    expect(cleanSummary('WATCH — WETH a \\$2,578.99 y `liquidityUsd` en \\*cero\\*')).toBe('WATCH — WETH a $2,578.99 y `liquidityUsd` en *cero*');
  });
});

describe('el analista de Claude', () => {
  it('a text starting with ACT produces level actuar', async () => {
    const deps: AnalystDeps = {
      create: async () => textMessage('ACT: the position has closed, check the real state now.'),
    };

    const result = await analyzePosition(deps, FACTS);

    expect(result).toMatchObject({ kind: 'alert', level: 'actuar' });
  });

  it('a text starting with WATCH produces level vigilar', async () => {
    const deps: AnalystDeps = {
      create: async () => textMessage('WATCH: nothing urgent yet, keep an eye on the next hour.'),
    };

    const result = await analyzePosition(deps, FACTS);

    expect(result).toMatchObject({ kind: 'alert', level: 'vigilar' });
  });

  it('a text starting with OK produces level ok', async () => {
    const deps: AnalystDeps = { create: async () => textMessage('OK everything within range for now.') };

    const result = await analyzePosition(deps, FACTS);

    expect(result).toMatchObject({ kind: 'alert', level: 'ok' });
  });

  it('the old Spanish ACTUAR/VIGILAR words still map to the same levels', async () => {
    const actuarDeps: AnalystDeps = { create: async () => textMessage('ACTUAR: revisa ya el estado real.') };
    const vigilarDeps: AnalystDeps = { create: async () => textMessage('VIGILAR de cerca la próxima hora.') };

    expect(await analyzePosition(actuarDeps, FACTS)).toMatchObject({ kind: 'alert', level: 'actuar' });
    expect(await analyzePosition(vigilarDeps, FACTS)).toMatchObject({ kind: 'alert', level: 'vigilar' });
  });

  it('un stop_reason de refusal se traduce en refused sin leer content', async () => {
    // `content` es un getter que lanza si se lee: si analyzePosition mirase el
    // texto antes de comprobar stop_reason, esta prueba fallaría por la excepción
    // en vez de por una aserción incorrecta.
    const base = textMessage('esto nunca debería leerse');
    const poisoned = {
      ...base,
      stop_reason: 'refusal' as const,
      get content(): Anthropic.Beta.BetaContentBlock[] {
        throw new Error('no debería leerse content tras un rechazo');
      },
    } as unknown as Anthropic.Beta.BetaMessage;
    const deps: AnalystDeps = { create: async () => poisoned };

    const result = await analyzePosition(deps, FACTS);

    expect(result).toEqual({ kind: 'refused' });
  });

  it('una primera palabra que no es OK, VIGILAR ni ACTUAR se trata como vigilar', async () => {
    const deps: AnalystDeps = { create: async () => textMessage('mmm no sabría decir con certeza.') };

    const result = await analyzePosition(deps, FACTS);

    expect(result).toMatchObject({ kind: 'alert', level: 'vigilar' });
  });

  it('la petición enviada lleva el modelo, el fallback y el effort exactos', async () => {
    let sent: Anthropic.Beta.MessageCreateParamsNonStreaming | undefined;
    const deps: AnalystDeps = {
      create: async (params) => {
        sent = params;
        return textMessage('VIGILAR de cerca la próxima hora.');
      },
    };

    await analyzePosition(deps, FACTS);

    expect(sent?.model).toBe('claude-opus-5');
    expect(sent?.fallbacks).toBe('default');
    expect(sent?.betas).toContain('server-side-fallback-2026-07-01');
    expect(sent?.output_config).toEqual({ effort: 'low' });
    expect(typeof sent?.system).toBe('string');
    expect(sent?.messages).toHaveLength(1);
    const userContent = sent?.messages[0]?.content;
    expect(typeof userContent).toBe('string');
    const parsedFacts = JSON.parse(userContent as string);
    expect(parsedFacts).toEqual(FACTS);
  });

  it('the system prompt is in English and names OK, WATCH and ACT', async () => {
    let sent: Anthropic.Beta.MessageCreateParamsNonStreaming | undefined;
    const deps: AnalystDeps = {
      create: async (params) => {
        sent = params;
        return textMessage('OK everything within range for now.');
      },
    };

    await analyzePosition(deps, FACTS);

    const system = sent?.system;
    expect(typeof system).toBe('string');
    const text = system as string;
    expect(text).toContain('OK');
    expect(text).toContain('WATCH');
    expect(text).toContain('ACT');
    // No lingering Spanish instruction words from the old prompt.
    expect(text).not.toMatch(/VIGILAR|ACTUAR|español/i);
  });
});
