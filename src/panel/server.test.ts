import { describe, it, expect } from 'vitest';
import type { Hex } from 'viem';
import { createPanelApp, createEventBus, revokeNote, type PanelDeps, type OnChainBurn } from './server.js';
import { createNoteStore } from '../agent/note-store.js';
import { createNote } from '../accounting/note.js';
import type { AgentEvent } from '../agent/run.js';

const HOUR = 3_600_000;
const BOND_ADDRESS: Hex = '0x000000000000000000000000000000000000abcd';
const AGENT: Hex = '0x0000000000000000000000000000000000000022';

function makeDeps(overrides: Partial<PanelDeps> = {}): PanelDeps {
  return {
    notes: createNoteStore(createNote({ amountMicroUsdc: 100_000, expiresAt: Date.now() + HOUR })),
    bus: createEventBus(),
    indexHtml: '<title>panel de prueba</title>',
    ...overrides,
  };
}

describe('revokeNote', () => {
  it('quema la nota en el almacén compartido, sin red, sin nota on-chain inyectada', () => {
    const notes = createNoteStore(createNote({ amountMicroUsdc: 1_000, expiresAt: Date.now() + HOUR }));
    const bus = createEventBus();
    expect(notes.get().burned).toBe(false);

    revokeNote(notes, bus);

    expect(notes.get().burned).toBe(true);
    expect(bus.history()).toEqual([]); // sin `onChain`, no hay nada que quemar en cadena
  });

  it('quema en memoria al instante y llama al quemador on-chain inyectado con el SALDO RESTANTE, sin bloquear', async () => {
    // La quema en memoria es síncrona; la quema on-chain
    // se dispara sin esperar su resultado ("without blocking the HTTP response").
    const note = { ...createNote({ amountMicroUsdc: 5_000, expiresAt: Date.now() + HOUR }), spentMicroUsdc: 1_000 };
    const notes = createNoteStore(note);
    const bus = createEventBus();
    const calls: { bondAddress: Hex; agent: Hex; amountMicroUsdc: number }[] = [];
    let resolveBurn: (txHash: Hex) => void = () => {};
    const burnPromise = new Promise<Hex>((resolve) => {
      resolveBurn = resolve;
    });
    const onChain: OnChainBurn = {
      bondAddress: BOND_ADDRESS,
      agent: AGENT,
      burn: async (bondAddress, agent, amountMicroUsdc) => {
        calls.push({ bondAddress, agent, amountMicroUsdc });
        return burnPromise;
      },
    };

    revokeNote(notes, bus, onChain);

    // La quema en memoria ya sucedió, aunque la promesa del quemador on-chain siga pendiente.
    expect(notes.get().burned).toBe(true);
    expect(calls).toEqual([{ bondAddress: BOND_ADDRESS, agent: AGENT, amountMicroUsdc: 4_000 }]);
    expect(bus.history()).toEqual([]); // todavía no hay resultado on-chain

    resolveBurn('0x00000000000000000000000000000000000000000000000000000000000001');
    await burnPromise;
    await new Promise((resolve) => setTimeout(resolve, 0)); // deja correr el .then() encadenado en revokeNote

    expect(bus.history()).toEqual([
      { kind: 'burned_onchain', txHash: '0x00000000000000000000000000000000000000000000000000000000000001' },
    ]);
  });

  it('publica burn_onchain_failed si el quemador inyectado falla, sin afectar la quema en memoria', async () => {
    const notes = createNoteStore(createNote({ amountMicroUsdc: 2_000, expiresAt: Date.now() + HOUR }));
    const bus = createEventBus();
    const onChain: OnChainBurn = {
      bondAddress: BOND_ADDRESS,
      agent: AGENT,
      burn: async () => {
        throw new Error('el relay rechazó la transacción');
      },
    };

    revokeNote(notes, bus, onChain);

    expect(notes.get().burned).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0)); // deja correr el .catch() encadenado

    expect(bus.history()).toEqual([{ kind: 'burn_onchain_failed', error: 'Error: el relay rechazó la transacción' }]);
  });
});

describe('createEventBus', () => {
  it('entrega los eventos publicados a cada suscriptor, y guarda un historial acotado', () => {
    const bus = createEventBus();
    const received: AgentEvent[] = [];
    const unsubscribe = bus.subscribe((event) => received.push(event));

    const event: AgentEvent = { kind: 'paid', tool: 'token_price', txId: 'tx-1', remainingMicroUsdc: 98_000 };
    bus.publish(event);

    expect(received).toEqual([event]);
    expect(bus.history()).toEqual([event]);

    unsubscribe();
    bus.publish({ kind: 'stopped', reason: 'exhausted' });
    expect(received).toEqual([event]); // ya no llega tras desuscribirse
    expect(bus.history()).toHaveLength(2); // pero el historial sigue creciendo
  });
});

describe('GET /', () => {
  it('sirve el HTML inyectado del panel', async () => {
    const app = createPanelApp(makeDeps());

    const res = await app.request('/');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('panel de prueba');
  });
});

describe('GET /state', () => {
  it('devuelve la nota actual y el historial de eventos', async () => {
    const bus = createEventBus();
    const notes = createNoteStore(createNote({ amountMicroUsdc: 5_000, expiresAt: Date.now() + HOUR }));
    const app = createPanelApp(makeDeps({ notes, bus }));
    bus.publish({ kind: 'considered', tool: 'token_price', priceMicroUsdc: 2_000, decision: { pay: true } });

    const res = await app.request('/state');
    const body = (await res.json()) as { note: { amountMicroUsdc: number }; events: AgentEvent[] };

    expect(body.note.amountMicroUsdc).toBe(5_000);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ kind: 'considered', tool: 'token_price' });
  });
});

describe('POST /burn', () => {
  it('quema la nota compartida y lo confirma en la respuesta, sin red', async () => {
    const notes = createNoteStore(createNote({ amountMicroUsdc: 5_000, expiresAt: Date.now() + HOUR }));
    const app = createPanelApp(makeDeps({ notes }));
    expect(notes.get().burned).toBe(false);

    const res = await app.request('/burn', { method: 'POST' });
    const body = (await res.json()) as { ok: boolean; note: { burned: boolean } };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.note.burned).toBe(true);
    expect(notes.get().burned).toBe(true);
  });

  it('con una nota tokenizada, quema en memoria de inmediato y llama al quemador on-chain inyectado con el saldo restante', async () => {
    const note = { ...createNote({ amountMicroUsdc: 5_000, expiresAt: Date.now() + HOUR }), spentMicroUsdc: 2_000 };
    const notes = createNoteStore(note);
    const calls: { bondAddress: Hex; agent: Hex; amountMicroUsdc: number }[] = [];
    const onChain: OnChainBurn = {
      bondAddress: BOND_ADDRESS,
      agent: AGENT,
      burn: async (bondAddress, agent, amountMicroUsdc) => {
        calls.push({ bondAddress, agent, amountMicroUsdc });
        return '0x00000000000000000000000000000000000000000000000000000000000002';
      },
    };
    const app = createPanelApp(makeDeps({ notes, onChain }));

    const res = await app.request('/burn', { method: 'POST' });
    const body = (await res.json()) as { ok: boolean; note: { burned: boolean } };

    // La respuesta HTTP no esperó a que se resolviera la llamada on-chain, pero para cuando
    // Hono ya sirvió la respuesta, revokeNote ya la ha disparado de forma síncrona.
    expect(res.status).toBe(200);
    expect(body.note.burned).toBe(true);
    expect(calls).toEqual([{ bondAddress: BOND_ADDRESS, agent: AGENT, amountMicroUsdc: 3_000 }]);
  });
});

describe('GET /events (Server-Sent Events)', () => {
  it('transmite cada evento publicado con el formato SSE exacto, sin red', async () => {
    const bus = createEventBus();
    const app = createPanelApp(makeDeps({ bus }));

    const res = await app.request('/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const event: AgentEvent = { kind: 'paid', tool: 'token_price', txId: 'tx-1', remainingMicroUsdc: 98_000 };
    bus.publish(event);

    const { value, done } = await reader.read();
    expect(done).toBe(false);
    const chunk = decoder.decode(value);

    // Formato SSE: cada mensaje es "data: <json>\n\n".
    expect(chunk).toMatch(/^data: .+\n\n$/);
    const sentLine = chunk.replace(/^data: /, '').trim();
    expect(JSON.parse(sentLine)).toEqual(event);

    await reader.cancel();
  });

  it('cada suscriptor nuevo solo ve eventos publicados después de conectarse', async () => {
    const bus = createEventBus();
    // Un evento anterior a la conexión — no debería llegar por el stream (para eso está /state).
    bus.publish({ kind: 'stopped', reason: 'exhausted' });
    const app = createPanelApp(makeDeps({ bus }));

    const res = await app.request('/events');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const freshEvent: AgentEvent = { kind: 'analyzed', level: 'vigilar', summary: 'todo tranquilo por ahora' };
    bus.publish(freshEvent);

    const { value } = await reader.read();
    const chunk = decoder.decode(value);
    expect(JSON.parse(chunk.replace(/^data: /, '').trim())).toEqual(freshEvent);

    await reader.cancel();
  });
});
