import type { Hex } from 'viem';
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
  | { kind: 'paid'; tool: string; txId: string | null; remainingMicroUsdc: number; receiptError?: string }
  | { kind: 'failed'; tool: string; error: string }
  | { kind: 'settle_failed'; tool: string; error: string }
  | { kind: 'analyzed'; level: AnalystLevel; summary: string }
  | { kind: 'analysis_refused' }
  | { kind: 'analysis_failed'; error: string }
  | { kind: 'stopped'; reason: 'exhausted' | 'expired' | 'burned' | 'max_rounds' }
  // La nota tokenizada en ATS. `issued_onchain` /
  // `issue_onchain_failed` los emite main.ts antes de arrancar el bucle; `burned_onchain` /
  // `burn_onchain_failed` los emite el panel tras `POST /burn`, sin bloquear la respuesta.
  // Ninguno de los dos cambia cómo gasta el bucle (`runAgent` no los emite ni los lee) — son
  // eventos puramente informativos para el panel.
  | { kind: 'issued_onchain'; bondAddress: Hex; deployTx: Hex; issueTx: Hex }
  | { kind: 'issue_onchain_failed'; error: string }
  | { kind: 'burned_onchain'; txHash: Hex }
  | { kind: 'burn_onchain_failed'; error: string };

export type AgentDeps = {
  /** La nota vive en un almacén compartido con el panel, no en una copia local. */
  notes: NoteStore;
  tools: ToolSpec[];
  /** La posición y el token que el agente vigila. */
  watch: { positionId: string; tokenContract: string };
  /** Envoltorio inyectado — nunca las funciones tal cual. */
  pay: (
    tool: ToolSpec,
    args: Record<string, string>,
  ) => Promise<{ status: number; body: string; txId: string | null; receiptError?: string }>;
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

      // Se comprueba el débito ANTES de pagar, con la foto de la nota que se
      // tenía en ese momento. Pagar primero y comprobar después podría gastar dinero real
      // que la contabilidad nunca llegase a registrar. (El gasto que de verdad se confirma
      // tras el pago no usa esta foto ni este `debit()` — ver el comentario más abajo.)
      const attempt = debit(note, tool.priceMicroUsdc, deps.now());
      if (!attempt.ok) {
        yield { kind: 'stopped', reason: attempt.reason };
        return;
      }

      const args = buildArgs(tool, deps.watch, lastPosition);
      let result: { status: number; body: string; txId: string | null; receiptError?: string };
      try {
        result = await deps.pay(tool, args);
      } catch (error) {
        // El pago falló: no se confirma nada en la nota, se sigue con la siguiente
        // herramienta como si esta ronda nunca hubiera intentado comprarla.
        yield { kind: 'failed', tool: tool.name, error: String(error) };
        continue;
      }

      // Corrección crítica 1 (revisión de rama completa): `payAndRetry` puede devolver un
      // resultado con status no-2xx como VALOR en vez de lanzar (un 402 si la puerta lo
      // rechazó de nuevo, un 5xx del handler o de un settle que falló dentro de la puerta).
      // `@x402/hono` solo liquida en 2xx, así que un status fuera de ese rango significa que
      // NADA se movió de verdad en Hedera — tratarlo como pago (como hacía antes este código)
      // confirmaría un débito fantasma y liquidaría en Arc por dinero que nunca salió. Se
      // trata exactamente igual que el pago que lanza justo arriba: `failed` y se sigue, sin
      // tocar la nota, sin liquidar, sin marcar `paidSomething`.
      if (result.status < 200 || result.status >= 300) {
        yield { kind: 'failed', tool: tool.name, error: `la puerta respondió status ${result.status}: no se pagó nada` };
        continue;
      }

      // Corrección crítica: `deps.pay` puede tardar, y una
      // revocación (o el vencimiento de la nota) puede llegar MIENTRAS se espera su
      // respuesta — el bucle del agente y el panel comparten el mismo bucle de eventos en
      // main.ts. Confirmar aquí `attempt.note` (la foto de ANTES del await) resucitaría una
      // nota ya quemada (burned: false), y el siguiente intento seguiría gastando de una
      // nota que el usuario ya revocó. Por eso se relee la nota EN VIVO después del await y
      // el gasto se aplica sobre ELLA — preservando `burned`, `expiresAt` y cualquier otro
      // cambio ocurrido durante el pago — en vez de confirmar `attempt.note`. No se llama a
      // debit() aquí: una nota ya quemada lo rechazaría, y el pago ya sucedió de verdad, así
      // que el gasto tiene que quedar contabilizado de todos modos.
      const live = deps.notes.get();
      const committed = { ...live, spentMicroUsdc: live.spentMicroUsdc + tool.priceMicroUsdc };
      deps.notes.set(committed);

      // Hallazgo importante 2: `${tool.name}-${round}` a secas colisiona entre dos ejecuciones
      // distintas que comparten herramienta y ronda — la clave de idempotencia de Circle sale
      // solo de esta ref, así que dos notas distintas podrían pisarse la liquidación. Se
      // prefija con el id de la nota (UUID fresco por ejecución, leído de la nota EN VIVO, no
      // de una constante) para que la ref sea única por ejecución incluso sin txId real.
      const ref = result.txId ?? `${live.id}-${tool.name}-${round}`;
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
      // Corrección crítica 1: `paidSomething` solo se marca aquí, tras un parseo con éxito —
      // es la única prueba de que de verdad se obtuvo un dato con este pago.
      try {
        const parsed: unknown = JSON.parse(result.body);
        if (tool.name === 'position_state') {
          lastPosition = parsed as PositionState;
        } else if (tool.name === 'token_price') {
          const price = parsed as TokenPrice;
          lastPrices.set(price.contract, price);
        }
        lastSeen.set(tool.name, deps.now());
        paidSomething = true;
        yield {
          kind: 'paid',
          tool: tool.name,
          txId: result.txId,
          remainingMicroUsdc: remaining(committed),
          ...(result.receiptError !== undefined ? { receiptError: result.receiptError } : {}),
        };
      } catch (error) {
        yield { kind: 'failed', tool: tool.name, error: String(error) };
      }

      // La nota leída en vivo tras el pago (`live`) puede haber sido revocada, o haber
      // vencido, MIENTRAS ese pago estaba en curso. El gasto que ya sucedió queda
      // contabilizado arriba pase lo que pase, pero el agente se para aquí mismo — antes de
      // considerar ninguna herramienta más — en vez de seguir gastando de una nota que el
      // usuario acaba de revocar o que ya venció durante la espera.
      if (live.burned) {
        yield { kind: 'stopped', reason: 'burned' };
        return;
      }
      if (deps.now() > live.expiresAt) {
        yield { kind: 'stopped', reason: 'expired' };
        return;
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
