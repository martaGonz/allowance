import { createNote } from '../accounting/note.js';
import { createNoteStore } from './note-store.js';
import { runAgent, type AgentDeps } from './run.js';
import { livePay, liveSettle, liveAnalyst } from './live.js';
import { TOOLS } from '../graph/tools.js';
import { createEventBus, startPanel } from '../panel/server.js';

// WETH en Base — vigilada por defecto cuando WATCH_TOKEN_CONTRACT no se configura.
const DEFAULT_WATCH_TOKEN_CONTRACT = '0x4200000000000000000000000000000000000006';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPositiveInt(name: string): number {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} no configurada`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} inválida: "${raw}" no es un entero positivo`);
  }
  return value;
}

function readWatch(): AgentDeps['watch'] {
  const positionId = process.env.WATCH_POSITION_ID;
  if (!positionId) throw new Error('WATCH_POSITION_ID no configurada');
  return {
    positionId,
    tokenContract: process.env.WATCH_TOKEN_CONTRACT ?? DEFAULT_WATCH_TOKEN_CONTRACT,
  };
}

/**
 * Punto de entrada real: todo lo credenciado —
 * `livePay`, `liveSettle`, `liveAnalyst`, la nota emitida con las variables
 * de entorno — se construye aquí dentro, nunca al cargar el módulo. Nunca se
 * ejecuta desde un test; solo cuando este fichero se arranca como proceso
 * principal (`npx tsx src/agent/main.ts`), con `.env` cargado y las cuentas
 * de verdad fondeadas.
 */
async function main(): Promise<void> {
  const note = createNote({
    amountMicroUsdc: readPositiveInt('ALLOWANCE_AMOUNT_MICRO_USDC'),
    expiresAt: Date.now() + readPositiveInt('ALLOWANCE_TTL_MS'),
  });
  const notes = createNoteStore(note);
  const watch = readWatch();
  const bus = createEventBus();

  startPanel(notes, bus);

  const deps: AgentDeps = {
    notes,
    tools: TOOLS,
    watch,
    pay: livePay,
    settle: liveSettle,
    wait,
    now: () => Date.now(),
    analyst: liveAnalyst(),
  };

  console.log(`agente arrancado: paga de ${note.amountMicroUsdc} microUSDC, vence en ${note.expiresAt}`);
  for await (const event of runAgent(deps)) {
    bus.publish(event);
    console.log(event);
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
