import { describe, it, expect } from 'vitest';
import { buildPaymentRoutes, HEDERA_TESTNET_NETWORK, HEDERA_TESTNET_USDC } from './routes.js';
import { TOOLS, type ToolSpec } from '../graph/tools.js';
import type { RouteConfig, PaymentOption } from '@x402/core/http';

function acceptsOf(config: RouteConfig): PaymentOption {
  return Array.isArray(config.accepts) ? config.accepts[0]! : config.accepts;
}

describe('buildPaymentRoutes', () => {
  it('produce GET /tools/<name> por cada herramienta, con su precio como importe atómico en USDC de Hedera testnet', () => {
    const routes = buildPaymentRoutes(TOOLS) as Record<string, RouteConfig>;
    for (const tool of TOOLS) {
      const route = routes[`GET /tools/${tool.name}`];
      expect(route).toBeDefined();
      const accepts = acceptsOf(route!);
      expect(accepts.scheme).toBe('exact');
      expect(accepts.network).toBe(HEDERA_TESTNET_NETWORK);
      expect(accepts.price).toEqual({ asset: HEDERA_TESTNET_USDC, amount: String(tool.priceMicroUsdc) });
    }
  });

  it('ninguna ruta sale gratis: el importe siempre es positivo', () => {
    const routes = buildPaymentRoutes(TOOLS) as Record<string, RouteConfig>;
    for (const key of Object.keys(routes)) {
      const accepts = acceptsOf(routes[key]!);
      const price = accepts.price as { amount: string };
      expect(Number(price.amount)).toBeGreaterThan(0);
    }
  });

  it('una lista vacía no produce rutas', () => {
    expect(buildPaymentRoutes([])).toEqual({});
  });

  it('rechaza una herramienta con precio no positivo: no hay ruta gratis posible', () => {
    const gratis: ToolSpec = { name: 'gratis', description: '', priceMicroUsdc: 0, maxStaleMs: 1 };
    expect(() => buildPaymentRoutes([gratis])).toThrow();
  });
});
