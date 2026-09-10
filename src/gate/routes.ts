import type { RoutesConfig, RouteConfig, DynamicPayTo } from '@x402/core/http';
import type { ToolSpec } from '../graph/tools.js';

// Verificado en el mirror node de Hedera testnet: token 0.0.429274, símbolo USDC,
// 6 decimales, FUNGIBLE_COMMON. Un microUSDC interno equivale a una unidad atómica: sin conversión.
export const HEDERA_TESTNET_NETWORK = 'hedera:testnet' as const;
export const HEDERA_TESTNET_USDC = '0.0.429274';

// Cuenta receptora leída dentro de la función, nunca al cargar el módulo.
const resolvePayTo: DynamicPayTo = () => {
  const accountId = process.env.GATE_PAYTO_ACCOUNT_ID;
  if (!accountId) {
    throw new Error('GATE_PAYTO_ACCOUNT_ID no configurada: la puerta no puede cobrar');
  }
  return accountId;
};

/**
 * Traduce el catálogo de herramientas a la RoutesConfig que exige
 * `paymentMiddleware` de `@x402/hono`: una ruta GET por herramienta, con su
 * precio ya en unidades atómicas de USDC de Hedera testnet. Ninguna ruta sale
 * gratis: una herramienta con precio no positivo hace fallar la construcción
 * en vez de producir una ruta sin cobro.
 */
export function buildPaymentRoutes(tools: ToolSpec[]): RoutesConfig {
  const routes: Record<string, RouteConfig> = {};
  for (const tool of tools) {
    if (!Number.isInteger(tool.priceMicroUsdc) || tool.priceMicroUsdc <= 0) {
      throw new RangeError(`precio inválido para "${tool.name}": ${tool.priceMicroUsdc}`);
    }
    routes[`GET /tools/${tool.name}`] = {
      description: tool.description,
      accepts: {
        scheme: 'exact',
        network: HEDERA_TESTNET_NETWORK,
        price: { asset: HEDERA_TESTNET_USDC, amount: String(tool.priceMicroUsdc) },
        payTo: resolvePayTo,
      },
    };
  }
  return routes;
}
