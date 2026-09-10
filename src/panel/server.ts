import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import type { Hex } from 'viem';
import { burn, remaining } from '../accounting/note.js';
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
 * La nota tokenizada en ATS que `revokeNote` necesita para revocarla también en cadena
 * `burn` está inyectada — nunca `burnNoteOnChain` ni
 * `liveAtsDeps` directamente — para que `server.test.ts` siga sin red.
 */
export type OnChainBurn = {
  bondAddress: Hex;
  agent: Hex;
  burn: (bondAddress: Hex, agent: Hex, amountMicroUsdc: number) => Promise<Hex>;
};

/**
 * Revoca la nota de la paga. La quema en memoria sigue siendo síncrona y
 * ocurre primero — el agente deja de poder gastar en el mismo tick en que se llama, tanto si
 * hay nota tokenizada como si no. Si `onChain` está presente, se dispara además `onChain.burn(...)` con el SALDO RESTANTE de antes de
 * quemar SIN esperar su
 * resultado — su éxito o fallo se publica
 * en el bus (`burned_onchain` / `burn_onchain_failed`) cuando llegue, de forma asíncrona.
 */
export function revokeNote(notes: NoteStore, bus: EventBus, onChain?: OnChainBurn): void {
  const before = notes.get();
  notes.set(burn(before));

  if (!onChain) return;
  const amountMicroUsdc = remaining(before);
  onChain
    .burn(onChain.bondAddress, onChain.agent, amountMicroUsdc)
    .then((txHash) => bus.publish({ kind: 'burned_onchain', txHash }))
    .catch((error: unknown) => bus.publish({ kind: 'burn_onchain_failed', error: String(error) }));
}

export type PanelDeps = {
  notes: NoteStore;
  bus: EventBus;
  indexHtml: string;
  /** Ausente si la nota nunca se emitió on-chain (variables
   * de entorno ausentes o `issueNoteOnChain` falló) — entonces `POST /burn` solo quema en
   * memoria, como antes. */
  onChain?: OnChainBurn;
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
    revokeNote(deps.notes, deps.bus, deps.onChain);
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
 * `EventBus` que también alimentan al bucle del agente, y el `OnChainBurn` ya resuelto si la nota se emitió de verdad en ATS.
 */
export function startPanel(notes: NoteStore, bus: EventBus, onChain?: OnChainBurn): void {
  // `exactOptionalPropertyTypes` distingue "propiedad ausente" de "propiedad presente con
  // valor undefined": se extiende condicionalmente en vez de pasar `onChain` siempre.
  const app = createPanelApp({ notes, bus, indexHtml: readIndexHtml(), ...(onChain ? { onChain } : {}) });
  serve({ fetch: app.fetch, port: PANEL_PORT });
  console.log(`panel escuchando en :${PANEL_PORT}`);
}
