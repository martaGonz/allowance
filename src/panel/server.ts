import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { burn } from '../accounting/note.js';
import type { NoteStore } from '../agent/note-store.js';
import type { AgentEvent } from '../agent/run.js';

const HISTORY_LIMIT = 200;
const PANEL_PORT = Number(process.env.PANEL_PORT ?? '8787');

/**
 * Reparte cada `AgentEvent` a quien esté escuchando `GET /events`, y guarda
 * un historial acotado para que un panel recién abierto (`GET /state`) pueda
 * pintar el estado ya conocido en vez de arrancar en blanco.
 */
export type EventBus = {
  subscribe(listener: (event: AgentEvent) => void): () => void;
  publish(event: AgentEvent): void;
  history(): AgentEvent[];
};

export function createEventBus(): EventBus {
  const listeners = new Set<(event: AgentEvent) => void>();
  const log: AgentEvent[] = [];
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(event) {
      log.push(event);
      if (log.length > HISTORY_LIMIT) log.shift();
      for (const listener of listeners) listener(event);
    },
    history: () => [...log],
  };
}

/**
 * Revoca la nota de la paga: hoy solo la quema en memoria.
 * La sustituirá el cuerpo de esta función por una quema real en
 * cadena (`burnNoteOnChain`) sin tocar el resto del panel ni el bucle del
 * agente — es la única función que ese cambio necesita tocar.
 */
export function revokeNote(notes: NoteStore): void {
  notes.set(burn(notes.get()));
}

export type PanelDeps = {
  notes: NoteStore;
  bus: EventBus;
  indexHtml: string;
};

/**
 * El núcleo testeable del panel: recibe el HTML ya leído (nunca toca disco
 * aquí, igual que `createGateApp` recibe su `GraphClient` ya construido), así
 * que los tests pueden inyectar cualquier cosa sin tocar el sistema de
 * ficheros ni la red.
 */
export function createPanelApp(deps: PanelDeps): Hono {
  const app = new Hono();

  app.get('/', (c) => c.html(deps.indexHtml));

  // Snapshot para un panel que se acaba de abrir (o que se recargó a mitad de demo):
  // la nota actual más el historial acotado de eventos, para no arrancar en blanco.
  app.get('/state', (c) => c.json({ note: deps.notes.get(), events: deps.bus.history() }));

  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = deps.bus.subscribe((event) => {
        void stream.writeSSE({ data: JSON.stringify(event) });
      });
      // Mantiene la conexión abierta hasta que el cliente se desconecte: streamSSE cierra
      // el stream en cuanto este callback termina, así que espera a onAbort en vez de volver.
      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });
      unsubscribe();
    }),
  );

  app.post('/burn', (c) => {
    revokeNote(deps.notes);
    return c.json({ ok: true, note: deps.notes.get() });
  });

  return app;
}

function readIndexHtml(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, 'index.html'), 'utf8');
}

/**
 * Arranca el panel de verdad: lee `index.html` del disco (nunca al cargar el
 * módulo, solo cuando de verdad se arranca) y sirve `createPanelApp` sobre
 * `@hono/node-server`. `main.ts` es quien la llama, con el `NoteStore` y el
 * `EventBus` que también alimentan al bucle del agente.
 */
export function startPanel(notes: NoteStore, bus: EventBus): void {
  const app = createPanelApp({ notes, bus, indexHtml: readIndexHtml() });
  serve({ fetch: app.fetch, port: PANEL_PORT });
  console.log(`panel escuchando en :${PANEL_PORT}`);
}
