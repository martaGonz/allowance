import { debit, remaining } from '../accounting/note.js';
import { decide, type Decision } from './decide.js';
import type { ToolSpec } from '../graph/tools.js';
import type { PositionState, TokenPrice } from '../graph/client.js';
import { analyzePosition, type AnalystDeps, type AnalystLevel, type PositionFacts } from './analyst.js';
import type { NoteStore } from './note-store.js';

// Cuánto espera el agente entre rondas en las que nada mereció la
// pena comprar. Sin esto, una ronda en la que todo sigue fresco reintentaría
// en un bucle apretado en vez de esperar a que el dato caduque de verdad.
const WAIT_INTERVAL_MS = 5_000;

export type AgentEvent =
  | { kind: 'considered'; tool: string; priceMicroUsdc: number; decision: Decision }
  | { kind: 'paid'; tool: string; txId: string | null; remainingMicroUsdc: number }
  | { kind: 'failed'; tool: string; error: string }
  | { kind: 'settle_failed'; tool: string; error: string }
  | { kind: 'analyzed'; level: AnalystLevel; summary: string }
  | { kind: 'analysis_refused' }
  | { kind: 'analysis_failed'; error: string }
  | { kind: 'stopped'; reason: 'exhausted' | 'expired' | 'burned' | 'max_rounds' };

export type AgentDeps = {
  /** La nota vive en un almacén compartido con el panel, no en una copia local. */
  notes: NoteStore;
  tools: ToolSpec[];
  /** La posición y el token que el agente vigila. */
  watch: { positionId: string; tokenContract: string };
  /** Envoltorio inyectado — nunca las funciones tal cual. */
  pay: (tool: ToolSpec, args: Record<string, string>) => Promise<{ status: number; body: string; txId: string | null }>;
  /** Settle exige una ref para su clave de idempotencia. */
  settle: (amountMicroUsdc: number, ref: string) => Promise<string>;
  /** Esperar no es pararse; el temporizador real vive en main.ts. */
  wait: (ms: number) => Promise<void>;
  now: () => number;
  /** Opcional — su fallo o su rechazo nunca detiene el bucle ni debita nada. */
  analyst?: AnalystDeps;
  /** Para que los tests puedan acotar el bucle. */
  maxRounds?: number;
};

function buildArgs(
  tool: ToolSpec,
  watch: AgentDeps['watch'],
  lastPosition: PositionState | null,
): Record<string, string> {
  if (tool.name === 'position_state') return { positionId: watch.positionId };
  if (tool.name === 'token_price') return { contract: lastPosition?.token0 ?? watch.tokenContract };
  return {};
}

/**
 * El bucle del agente: en cada ronda considera cada herramienta del catálogo,
 * paga las que decide() aprueba, se para en seco si un débito falla de
 * verdad (nota agotada, vencida o quemada) y llama al analista de Claude tras
 * cualquier ronda en la que haya pagado al menos un dato. Nunca
 * es el analista quien decide gastar: eso es exclusivamente decide().
 */
export async function* runAgent(deps: AgentDeps): AsyncGenerator<AgentEvent> {
  const lastSeen = new Map<string, number>();
  const lastPrices = new Map<string, TokenPrice>();
  let lastPosition: PositionState | null = null;
  let round = 0;

  while (true) {
    round += 1;
    if (deps.maxRounds !== undefined && round > deps.maxRounds) {
      yield { kind: 'stopped', reason: 'max_rounds' };
      return;
    }

    let paidSomething = false;
    const refusedTools: string[] = [];

    for (const tool of deps.tools) {
      // La nota se lee del almacén compartido en cada intento, nunca de una
      // copia local — así una revocación entre rondas (o entre herramientas de la misma
      // ronda) se ve de inmediato, sin que nadie tenga que empujarla al bucle.
      const note = deps.notes.get();
      const knownAgeMs = deps.now() - (lastSeen.get(tool.name) ?? 0);
      const decision = decide({
        priceMicroUsdc: tool.priceMicroUsdc,
        remainingMicroUsdc: remaining(note),
        knownAgeMs,
        maxStaleMs: tool.maxStaleMs,
      });
      yield { kind: 'considered', tool: tool.name, priceMicroUsdc: tool.priceMicroUsdc, decision };

      if (!decision.pay) {
        refusedTools.push(tool.name);
        continue;
      }

      // Se comprueba el débito ANTES de pagar y solo se confirma en la nota
      // DESPUÉS de que el pago tenga éxito. Pagar primero y debitar después podría gastar
      // dinero real que la contabilidad nunca llegase a registrar.
      const attempt = debit(note, tool.priceMicroUsdc, deps.now());
      if (!attempt.ok) {
        yield { kind: 'stopped', reason: attempt.reason };
        return;
      }

      const args = buildArgs(tool, deps.watch, lastPosition);
      let result: { status: number; body: string; txId: string | null };
      try {
        result = await deps.pay(tool, args);
      } catch (error) {
        // El pago falló: no se confirma nada en la nota, se sigue con la siguiente
        // herramienta como si esta ronda nunca hubiera intentado comprarla.
        yield { kind: 'failed', tool: tool.name, error: String(error) };
        continue;
      }

      deps.notes.set(attempt.note);
      paidSomething = true;

      // Ref para la clave de idempotencia de settle — el txId real del pago
      // x402 si lo hay, o si no un identificador determinista de intento (herramienta + ronda).
      const ref = result.txId ?? `${tool.name}-${round}`;
      try {
        await deps.settle(tool.priceMicroUsdc, ref);
      } catch (error) {
        // El pago ya sucedió y el débito ya está confirmado arriba — un fallo
        // de liquidación no deshace nada, solo se informa y se sigue.
        yield { kind: 'settle_failed', tool: tool.name, error: String(error) };
      }

      // El pago ya sucedió y el débito ya se confirmó arriba, así que un
      // cuerpo que no parsea es un evento `failed` (nunca un débito fantasma ni uno
      // perdido) — el dinero ya salió, simplemente no se pudo leer el dato comprado.
      try {
        const parsed: unknown = JSON.parse(result.body);
        if (tool.name === 'position_state') {
          lastPosition = parsed as PositionState;
        } else if (tool.name === 'token_price') {
          const price = parsed as TokenPrice;
          lastPrices.set(price.contract, price);
        }
        lastSeen.set(tool.name, deps.now());
        yield { kind: 'paid', tool: tool.name, txId: result.txId, remainingMicroUsdc: remaining(attempt.note) };
      } catch (error) {
        yield { kind: 'failed', tool: tool.name, error: String(error) };
      }
    }

    // Tras una ronda con al menos un pago con éxito, y solo si ya se conoce el
    // estado de la posición (facts.position no es opcional), se llama al analista. Su fallo
    // o su rechazo nunca detiene el bucle ni debita nada: solo se informa y se sigue.
    if (paidSomething && lastPosition && deps.analyst) {
      const note = deps.notes.get();
      const facts: PositionFacts = {
        position: lastPosition,
        prices: [...lastPrices.values()],
        spentMicroUsdc: note.spentMicroUsdc,
        remainingMicroUsdc: remaining(note),
        refusedTools,
      };
      try {
        const result = await analyzePosition(deps.analyst, facts);
        if (result.kind === 'refused') {
          yield { kind: 'analysis_refused' };
        } else {
          yield { kind: 'analyzed', level: result.level, summary: result.summary };
        }
      } catch (error) {
        yield { kind: 'analysis_failed', error: String(error) };
      }
    }

    const note = deps.notes.get();
    const cheapest = Math.min(...deps.tools.map((t) => t.priceMicroUsdc));
    if (remaining(note) < cheapest) {
      yield { kind: 'stopped', reason: 'exhausted' };
      return;
    }

    // Esperar no es pararse. Si nada mereció la pena comprar esta ronda
    // (todo seguía fresco), el agente espera y vuelve a intentarlo, sin emitir `stopped`.
    if (!paidSomething) {
      await deps.wait(WAIT_INTERVAL_MS);
    }
  }
}
