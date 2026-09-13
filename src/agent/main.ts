import type { Hex } from 'viem';
import { createNote, type Note } from '../accounting/note.js';
import { createNoteStore } from './note-store.js';
import { runAgent, type AgentDeps } from './run.js';
import { livePay, liveSettle, liveSettlementHash, liveAnalyst } from './live.js';
import { TOOLS } from '../graph/tools.js';
import { createEventBus, startPanel, type EventBus, type OnChainBurn } from '../panel/server.js';
import { issueNoteOnChain, burnNoteOnChain, liveAtsDeps } from '../hedera/ats.js';

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
 * Si `ATS_ISSUER_PRIVATE_KEY` y `HEDERA_EVM_ADDRESS` están
 * configuradas, tokeniza la nota en Asset Tokenization Studio ANTES de arrancar el bucle y
 * devuelve el `OnChainBurn` que el botón "Revocar" del panel necesita para quemar de verdad
 * Si `issueNoteOnChain` lanza, se publica `issue_onchain_failed` y el agente
 * arranca igual, con la nota solo en memoria — la nunca puede impedir que el agente
 * funcione. Si las variables faltan, se salta en silencio (un único log informativo): no es
 * un error, es el modo por defecto sin cuentas testnet fondeadas.
 */
async function issueOnChainIfConfigured(note: Note, bus: EventBus): Promise<OnChainBurn | undefined> {
  const issuerKeyConfigured = Boolean(process.env.ATS_ISSUER_PRIVATE_KEY);
  const agentAddress = process.env.HEDERA_EVM_ADDRESS;
  if (!issuerKeyConfigured || !agentAddress) {
    console.log('ATS_ISSUER_PRIVATE_KEY / HEDERA_EVM_ADDRESS no configuradas: la nota se queda solo en memoria');
    return undefined;
  }

  const agent = agentAddress as Hex;
  try {
    const deps = liveAtsDeps();
    const result = await issueNoteOnChain(deps, note, agent);
    bus.publish({
      kind: 'issued_onchain',
      bondAddress: result.bondAddress,
      deployTx: result.deployTx,
      issueTx: result.issueTx,
    });
    return {
      bondAddress: result.bondAddress,
      agent,
      // Reutiliza los mismos clientes viem de la emisión — no vuelve a leer
      // ATS_ISSUER_PRIVATE_KEY ni reconstruye la conexión en cada quema.
      burn: (bondAddress, burnAgent, amountMicroUsdc) => burnNoteOnChain(deps, bondAddress, burnAgent, amountMicroUsdc),
    };
  } catch (error) {
    bus.publish({ kind: 'issue_onchain_failed', error: String(error) });
    return undefined;
  }
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

  const onChain = await issueOnChainIfConfigured(note, bus);

  startPanel(notes, bus, onChain);

  // Minor de la revisión de rama completa: antes de este cambio, `liveAnalyst()` se construía
  // siempre — sin ANTHROPIC_API_KEY, `new Anthropic()` no lanza (resuelve la clave sola y la
  // deja en null), así que el agente igual la llamaba cada ronda con pago, solo para fallar
  // con un 401 y emitir `analysis_failed` una y otra vez. Se construye y se pasa el analista
  // solo si la clave está configurada; si no, se registra una sola línea y se corre sin él —
  // decide() sigue siendo el único que gasta de cualquier modo.
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('ANTHROPIC_API_KEY no configurada: el agente corre sin analista Claude (sigue gastando y parándose igual)');
  }

  const deps: AgentDeps = {
    notes,
    tools: TOOLS,
    watch,
    pay: livePay,
    settle: async (amountMicroUsdc, ref) => {
      const id = await liveSettle(amountMicroUsdc, ref);
      // El hash en Arc llega unos segundos después: se espera aparte para no frenar el bucle.
      liveSettlementHash(id)
        .then((txHash) => bus.publish({ kind: 'settled_onchain', amountMicroUsdc, txHash }))
        .catch((error: unknown) => bus.publish({ kind: 'settlement_hash_failed', error: String(error) }));
      return id;
    },
    wait,
    now: () => Date.now(),
    ...(process.env.ANTHROPIC_API_KEY ? { analyst: liveAnalyst() } : {}),
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
