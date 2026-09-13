import Anthropic from '@anthropic-ai/sdk';
import { payAndRetry } from '../gate/pay.js';
import { settle as settleOnArc, liveSettleDeps, settlementTxHash } from '../arc/treasury.js';
import { buildGateUrl } from '../mcp/gate-url.js';
import type { ToolSpec } from '../graph/tools.js';
import type { AnalystDeps } from './analyst.js';

// Los adaptadores en vivo viven aquí, NUNCA en run.ts — src/gate/pay.ts y
// src/arc/treasury.ts leen credenciales (HEDERA_*, CIRCLE_*) solo dentro de sus propias
// funciones, pero este fichero es el único que las invoca de verdad, así que run.test.ts
// puede importar run.ts sin que nada credenciado se construya al cargar el módulo.
const GATE_URL = process.env.GATE_URL ?? 'http://localhost:8402';

/**
 * Adaptador entre `AgentDeps.pay` y `payAndRetry`.
 * Construye la URL de la puerta con `buildGateUrl`, que codifica los
 * argumentos de la herramienta de forma segura en vez de concatenarlos a
 * mano. `payAndRetry` ya lanza si la puerta cotiza un importe distinto del
 * autorizado; run.ts trata ese lanzamiento
 * como un evento `failed`, nunca como un débito.
 */
export const livePay = async (
  tool: ToolSpec,
  args: Record<string, string>,
): Promise<{ status: number; body: string; txId: string | null }> => {
  const url = buildGateUrl(GATE_URL, tool.name, args);
  return payAndRetry(url, tool.priceMicroUsdc);
};

/**
 * Adaptador entre `AgentDeps.settle` y `settle`. La
 * firma real exige una `ref` para la clave de idempotencia de Circle; run.ts
 * ya se la pasa (el txId del pago x402, o un id determinista de intento).
 * `ARC_OPERATOR_ADDRESS` y las credenciales de Circle (vía `liveSettleDeps`)
 * se leen dentro de la función, nunca al cargar el módulo.
 */
export const liveSettle = async (amountMicroUsdc: number, ref: string): Promise<string> => {
  const operator = process.env.ARC_OPERATOR_ADDRESS;
  if (!operator) {
    throw new Error('ARC_OPERATOR_ADDRESS no configurada: no se puede liquidar en Arc de verdad');
  }
  return settleOnArc(liveSettleDeps(), amountMicroUsdc, operator, ref);
};

/** Hash en Arc de una liquidación ya creada, para enlazarla en Arcscan desde el panel. */
export const liveSettlementHash = (id: string): Promise<string> => settlementTxHash(liveSettleDeps().client, id);

/**
 * Construye el analista real. `new Anthropic()` resuelve
 * `ANTHROPIC_API_KEY` por sí solo, y se construye DENTRO de la función:
 * importar este fichero desde un test (o desde run.ts) nunca debe reventar
 * por credenciales ausentes.
 */
export function liveAnalyst(): AnalystDeps {
  const client = new Anthropic();
  return { create: (params) => client.beta.messages.create(params) };
}
