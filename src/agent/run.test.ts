import { describe, it, expect } from 'vitest';
import { runAgent, type AgentDeps, type AgentEvent } from './run.js';
import { createNote, burn, remaining } from '../accounting/note.js';
import { createNoteStore } from './note-store.js';
import type { ToolSpec } from '../graph/tools.js';
import type { AnalystDeps } from './analyst.js';

const HOUR = 3_600_000;
const WATCH = { positionId: 'p1', tokenContract: '0xwatched' };

const priceTool: ToolSpec = {
  name: 'token_price',
  description: '',
  priceMicroUsdc: 2_000,
  maxStaleMs: 0,
};

const positionTool: ToolSpec = {
  name: 'position_state',
  description: '',
  priceMicroUsdc: 12_000,
  maxStaleMs: 0,
};

/** Deps base con fakes inertes; cada prueba sobreescribe lo que necesita. */
function baseDeps(overrides: Partial<AgentDeps>): AgentDeps {
  return {
    notes: createNoteStore(createNote({ amountMicroUsdc: 1_000_000, expiresAt: Date.now() + HOUR })),
    tools: [priceTool],
    watch: WATCH,
    pay: async () => ({ status: 200, body: '{}', txId: 'tx' }),
    settle: async () => '0xhash',
    wait: async () => {},
    now: () => Date.now(),
    ...overrides,
  };
}

async function collect(deps: AgentDeps): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of runAgent(deps)) events.push(event);
  return events;
}

describe('bucle del agente', () => {
  it('se para exactamente al agotar la paga, ni antes ni después', async () => {
    const note = createNote({ amountMicroUsdc: 4_000, expiresAt: Date.now() + HOUR });
    const events = await collect(
      baseDeps({
        notes: createNoteStore(note),
        tools: [priceTool],
      }),
    );

    const paid = events.filter((e) => e.kind === 'paid');
    expect(paid).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ kind: 'stopped', reason: 'exhausted' });
  });

  it('un fallo de la fuente no produce débito ni cambia la nota', async () => {
    const note = createNote({ amountMicroUsdc: 10_000, expiresAt: Date.now() + HOUR });
    const store = createNoteStore(note);
    const events = await collect(
      baseDeps({
        notes: store,
        tools: [priceTool],
        pay: async () => {
          throw new Error('The Graph caído');
        },
        maxRounds: 1,
      }),
    );

    expect(events.filter((e) => e.kind === 'paid')).toHaveLength(0);
    expect(events.some((e) => e.kind === 'failed')).toBe(true);
    // Sin pago, no hay débito — la nota queda exactamente igual.
    expect(remaining(store.get())).toBe(10_000);
    expect(store.get()).toBe(note);
  });

  it('cuando el pago lanza, la nota permanece sin cambios (no solo el remaining)', async () => {
    const note = createNote({ amountMicroUsdc: 10_000, expiresAt: Date.now() + HOUR });
    const store = createNoteStore(note);
    await collect(
      baseDeps({
        notes: store,
        tools: [priceTool],
        pay: async () => {
          throw new Error('caído');
        },
        maxRounds: 2,
      }),
    );

    expect(store.get()).toEqual(note);
  });

  it('una nota quemada entre rondas para al agente con "burned", sin volver a pagar', async () => {
    const note = createNote({ amountMicroUsdc: 10_000, expiresAt: Date.now() + HOUR });
    const store = createNoteStore(note);
    let payCalls = 0;

    const events = await collect(
      baseDeps({
        notes: store,
        tools: [priceTool],
        pay: async () => {
          payCalls += 1;
          return { status: 200, body: '{}', txId: 'tx-1' };
        },
        // Simula la revocación llegando justo después de que la ronda 1 confirme su
        // débito: el panel llamaría a store.set(burn(store.get())) en ese mismo instante.
        settle: async () => {
          store.set(burn(store.get()));
          return '0xhash';
        },
      }),
    );

    expect(payCalls).toBe(1);
    expect(events.filter((e) => e.kind === 'paid')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: 'stopped', reason: 'burned' });
  });

  it('una revocación durante un pago en curso no se deshace', async () => {
    // El bucle del agente y el panel comparten el mismo bucle de eventos en main.ts: una
    // revocación puede llegar MIENTRAS `pay` todavía está pendiente. El pago x402 ya se
    // emitió de verdad para cuando eso ocurre, así que confirmarlo tiene que preservar la
    // quema en vez de resucitar la nota con la foto de antes del await.
    const note = createNote({ amountMicroUsdc: 10_000, expiresAt: Date.now() + HOUR });
    const store = createNoteStore(note);
    let payCalls = 0;
    const settleRefs: string[] = [];

    const events = await collect(
      baseDeps({
        notes: store,
        tools: [priceTool],
        pay: async () => {
          payCalls += 1;
          // La revocación llega EN MITAD del pago, antes de que resuelva.
          store.set(burn(store.get()));
          return { status: 200, body: '{}', txId: 'tx-1' };
        },
        settle: async (_amount, ref) => {
          settleRefs.push(ref);
          return '0xhash';
        },
      }),
    );

    expect(payCalls).toBe(1);
    expect(store.get().burned).toBe(true);
    expect(settleRefs).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: 'stopped', reason: 'burned' });
  });

  it('un gasto hecho mientras la paga se revoca queda contabilizado', async () => {
    const note = createNote({ amountMicroUsdc: 10_000, expiresAt: Date.now() + HOUR });
    const store = createNoteStore(note);

    await collect(
      baseDeps({
        notes: store,
        tools: [priceTool],
        pay: async () => {
          store.set(burn(store.get()));
          return { status: 200, body: '{}', txId: 'tx-1' };
        },
      }),
    );

    expect(store.get().spentMicroUsdc).toBe(2_000);
  });

  it('cuando todo sigue fresco, el agente espera y no se para', async () => {
    const note = createNote({ amountMicroUsdc: 1_000_000, expiresAt: Date.now() + HOUR });
    const freshTool: ToolSpec = { name: 'token_price', description: '', priceMicroUsdc: 2_000, maxStaleMs: HOUR };
    let waitCalls = 0;

    const events = await collect(
      baseDeps({
        notes: createNoteStore(note),
        tools: [freshTool],
        wait: async () => {
          waitCalls += 1;
        },
        maxRounds: 3,
      }),
    );

    const paid = events.filter((e) => e.kind === 'paid');
    // Solo la primera ronda paga (dato nunca visto = viejo por definición); las
    // rondas 2 y 3 lo ven fresco y no compran nada.
    expect(paid).toHaveLength(1);
    expect(events.some((e) => e.kind === 'stopped' && 'reason' in e && e.reason !== 'max_rounds')).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: 'stopped', reason: 'max_rounds' });
    expect(waitCalls).toBeGreaterThan(0);
  });

  it('respeta maxRounds incluso si nunca se agota ni se quema', async () => {
    const note = createNote({ amountMicroUsdc: 1_000_000, expiresAt: Date.now() + HOUR });
    const events = await collect(
      baseDeps({
        notes: createNoteStore(note),
        tools: [{ name: 'token_price', description: '', priceMicroUsdc: 2_000, maxStaleMs: 0 }],
        maxRounds: 2,
      }),
    );

    expect(events.filter((e) => e.kind === 'paid')).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ kind: 'stopped', reason: 'max_rounds' });
  });

  it('token_price usa el token0 de la última position_state pagada con éxito', async () => {
    const note = createNote({ amountMicroUsdc: 1_000_000, expiresAt: Date.now() + HOUR });
    const calls: Array<{ tool: string; args: Record<string, string> }> = [];

    const positionBody = JSON.stringify({
      positionId: 'p1',
      liquidity: '1',
      liquidityUsd: '2',
      token0: '0xTOKEN0',
      token1: '0xTOKEN1',
      closed: false,
    });

    const events = await collect(
      baseDeps({
        notes: createNoteStore(note),
        tools: [positionTool, priceTool],
        pay: async (tool, args) => {
          calls.push({ tool: tool.name, args });
          if (tool.name === 'position_state') return { status: 200, body: positionBody, txId: 'tx-pos' };
          return { status: 200, body: '{"contract":"0xTOKEN0","priceUsd":1,"asOf":0}', txId: 'tx-price' };
        },
        maxRounds: 1,
      }),
    );

    expect(events.filter((e) => e.kind === 'paid')).toHaveLength(2);
    const positionCall = calls.find((c) => c.tool === 'position_state');
    const priceCall = calls.find((c) => c.tool === 'token_price');
    expect(positionCall?.args).toEqual({ positionId: 'p1' });
    expect(priceCall?.args).toEqual({ contract: '0xTOKEN0' });
  });

  it('sin position_state previa, token_price usa watch.tokenContract', async () => {
    const note = createNote({ amountMicroUsdc: 1_000_000, expiresAt: Date.now() + HOUR });
    let receivedArgs: Record<string, string> | undefined;

    await collect(
      baseDeps({
        notes: createNoteStore(note),
        tools: [priceTool],
        pay: async (_tool, args) => {
          receivedArgs = args;
          return { status: 200, body: '{}', txId: 'tx' };
        },
        maxRounds: 1,
      }),
    );

    expect(receivedArgs).toEqual({ contract: WATCH.tokenContract });
  });

  it('un cuerpo que no parsea produce failed pero el débito ya confirmado se queda', async () => {
    const note = createNote({ amountMicroUsdc: 10_000, expiresAt: Date.now() + HOUR });
    const store = createNoteStore(note);

    const events = await collect(
      baseDeps({
        notes: store,
        tools: [priceTool],
        pay: async () => ({ status: 200, body: 'esto no es json', txId: 'tx' }),
        maxRounds: 1,
      }),
    );

    expect(events.filter((e) => e.kind === 'paid')).toHaveLength(0);
    expect(events.some((e) => e.kind === 'failed')).toBe(true);
    expect(remaining(store.get())).toBe(8_000);
  });

  it('un fallo de settle no detiene al agente ni revierte el débito', async () => {
    const note = createNote({ amountMicroUsdc: 10_000, expiresAt: Date.now() + HOUR });
    const store = createNoteStore(note);

    const events = await collect(
      baseDeps({
        notes: store,
        tools: [priceTool],
        settle: async () => {
          throw new Error('Circle caído');
        },
        maxRounds: 1,
      }),
    );

    expect(events.some((e) => e.kind === 'settle_failed')).toBe(true);
    expect(events.filter((e) => e.kind === 'paid')).toHaveLength(1);
    expect(remaining(store.get())).toBe(8_000);
  });

  it('settle recibe el txId del pago como ref', async () => {
    const note = createNote({ amountMicroUsdc: 10_000, expiresAt: Date.now() + HOUR });
    const refs: string[] = [];

    await collect(
      baseDeps({
        notes: createNoteStore(note),
        tools: [priceTool],
        pay: async () => ({ status: 200, body: '{}', txId: 'tx-real' }),
        settle: async (_amount, ref) => {
          refs.push(ref);
          return '0xhash';
        },
        maxRounds: 1,
      }),
    );

    expect(refs).toEqual(['tx-real']);
  });

  it('sin txId, settle recibe una ref determinista de herramienta + ronda', async () => {
    const note = createNote({ amountMicroUsdc: 10_000, expiresAt: Date.now() + HOUR });
    const refs: string[] = [];

    await collect(
      baseDeps({
        notes: createNoteStore(note),
        tools: [priceTool],
        pay: async () => ({ status: 200, body: '{}', txId: null }),
        settle: async (_amount, ref) => {
          refs.push(ref);
          return '0xhash';
        },
        maxRounds: 1,
      }),
    );

    expect(refs).toEqual(['token_price-1']);
  });

  it('llama al analista tras una ronda con al menos un pago, con los hechos correctos', async () => {
    const note = createNote({ amountMicroUsdc: 1_000_000, expiresAt: Date.now() + HOUR });
    const positionBody = JSON.stringify({
      positionId: 'p1',
      liquidity: '1',
      liquidityUsd: '2',
      token0: '0xTOKEN0',
      token1: '0xTOKEN1',
      closed: false,
    });
    let receivedFacts: unknown;
    const analyst: AnalystDeps = {
      create: async (params) => {
        const content = params.messages[0]?.content;
        receivedFacts = JSON.parse(content as string);
        return {
          content: [{ type: 'text', text: 'OK todo en orden.', citations: null }],
          stop_reason: 'end_turn',
        } as never;
      },
    };

    const events = await collect(
      baseDeps({
        notes: createNoteStore(note),
        tools: [positionTool, priceTool],
        pay: async (tool) => {
          if (tool.name === 'position_state') return { status: 200, body: positionBody, txId: 'tx-pos' };
          return { status: 200, body: '{"contract":"0xTOKEN0","priceUsd":2.5,"asOf":1}', txId: 'tx-price' };
        },
        analyst,
        maxRounds: 1,
      }),
    );

    expect(events.some((e) => e.kind === 'analyzed' && e.level === 'ok')).toBe(true);
    expect(receivedFacts).toMatchObject({
      position: { positionId: 'p1', token0: '0xTOKEN0' },
      refusedTools: [],
    });
  });

  it('sin position_state pagada nunca, no se llama al analista aunque haya pagos', async () => {
    const note = createNote({ amountMicroUsdc: 1_000_000, expiresAt: Date.now() + HOUR });
    let analystCalled = false;
    const analyst: AnalystDeps = {
      create: async () => {
        analystCalled = true;
        return { content: [{ type: 'text', text: 'OK.', citations: null }], stop_reason: 'end_turn' } as never;
      },
    };

    await collect(
      baseDeps({
        notes: createNoteStore(note),
        tools: [priceTool],
        analyst,
        maxRounds: 1,
      }),
    );

    expect(analystCalled).toBe(false);
  });

  it('un analista que lanza produce analysis_failed y el agente sigue gastando y parando igual que sin analista', async () => {
    const note = createNote({ amountMicroUsdc: 14_000, expiresAt: Date.now() + HOUR });
    const positionBody = JSON.stringify({
      positionId: 'p1',
      liquidity: '1',
      liquidityUsd: '2',
      token0: '0xTOKEN0',
      token1: '0xTOKEN1',
      closed: false,
    });
    const analyst: AnalystDeps = {
      create: async () => {
        throw new Error('la API de Claude no responde');
      },
    };

    const withAnalyst = await collect(
      baseDeps({
        notes: createNoteStore(createNote({ amountMicroUsdc: 14_000, expiresAt: Date.now() + HOUR })),
        tools: [positionTool, priceTool],
        pay: async (tool) => {
          if (tool.name === 'position_state') return { status: 200, body: positionBody, txId: 'tx-pos' };
          return { status: 200, body: '{"contract":"0xTOKEN0","priceUsd":1,"asOf":0}', txId: 'tx-price' };
        },
        analyst,
      }),
    );

    const withoutAnalyst = await collect(
      baseDeps({
        notes: createNoteStore(note),
        tools: [positionTool, priceTool],
        pay: async (tool) => {
          if (tool.name === 'position_state') return { status: 200, body: positionBody, txId: 'tx-pos' };
          return { status: 200, body: '{"contract":"0xTOKEN0","priceUsd":1,"asOf":0}', txId: 'tx-price' };
        },
      }),
    );

    expect(withAnalyst.some((e) => e.kind === 'analysis_failed')).toBe(true);
    const paidWith = withAnalyst.filter((e) => e.kind === 'paid');
    const paidWithout = withoutAnalyst.filter((e) => e.kind === 'paid');
    expect(paidWith).toEqual(paidWithout);
    expect(withAnalyst.at(-1)).toMatchObject({ kind: 'stopped', reason: 'exhausted' });
    expect(withAnalyst.at(-1)).toEqual(withoutAnalyst.at(-1));
  });

  it('un rechazo del analista no detiene al agente ni debita nada extra', async () => {
    const note = createNote({ amountMicroUsdc: 1_000_000, expiresAt: Date.now() + HOUR });
    const store = createNoteStore(note);
    const positionBody = JSON.stringify({
      positionId: 'p1',
      liquidity: '1',
      liquidityUsd: '2',
      token0: '0xTOKEN0',
      token1: '0xTOKEN1',
      closed: false,
    });
    const analyst: AnalystDeps = {
      create: async () => ({ content: [], stop_reason: 'refusal' }) as never,
    };

    const events = await collect(
      baseDeps({
        notes: store,
        tools: [positionTool, priceTool],
        pay: async (tool) => {
          if (tool.name === 'position_state') return { status: 200, body: positionBody, txId: 'tx-pos' };
          return { status: 200, body: '{"contract":"0xTOKEN0","priceUsd":1,"asOf":0}', txId: 'tx-price' };
        },
        analyst,
        maxRounds: 1,
      }),
    );

    expect(events.some((e) => e.kind === 'analysis_refused')).toBe(true);
    expect(remaining(store.get())).toBe(1_000_000 - 14_000);
  });
});
