import { describe, it, expect } from 'vitest';
import { createPanelApp, createEventBus, revokeNote, type PanelDeps } from './server.js';
import { createNoteStore } from '../agent/note-store.js';
import { createNote } from '../accounting/note.js';
import type { AgentEvent } from '../agent/run.js';

const HOUR = 3_600_000;

function makeDeps(overrides: Partial<PanelDeps> = {}): PanelDeps {
  return {
    notes: createNoteStore(createNote({ amountMicroUsdc: 100_000, expiresAt: Date.now() + HOUR })),
    bus: createEventBus(),
    indexHtml: '<title>panel de prueba</title>',
    ...overrides,
  };
}

describe('revokeNote', () => {
  it('quema la nota en el almacén compartido, sin red', () => {
    const notes = createNoteStore(createNote({ amountMicroUsdc: 1_000, expiresAt: Date.now() + HOUR }));
    expect(notes.get().burned).toBe(false);

    revokeNote(notes);

    expect(notes.get().burned).toBe(true);
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
