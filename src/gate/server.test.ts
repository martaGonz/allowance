import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { x402ResourceServer, type FacilitatorClient } from '@x402/core/server';
import type { SupportedResponse, VerifyResponse, SettleResponse } from '@x402/core/types';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { ExactHederaScheme } from '@x402/hedera/exact/server';
import { createGateApp, buildGraphClientFromEnv } from './server.js';
import type { GraphClient } from '../graph/client.js';

const FEE_PAYER = '0.0.999999';
const HEDERA_TESTNET_USDC = '0.0.429274';

type FakeFacilitatorClient = FacilitatorClient & {
  verify: ReturnType<typeof vi.fn>;
  settle: ReturnType<typeof vi.fn>;
  getSupported: ReturnType<typeof vi.fn>;
};

function fakeFacilitatorClient(): FakeFacilitatorClient {
  return {
    verify: vi.fn(async (): Promise<VerifyResponse> => ({ isValid: true, payer: '0.0.111111' })),
    settle: vi.fn(async (): Promise<SettleResponse> => ({
      success: true,
      transaction: 'esto-no-deberia-liquidarse',
      network: 'hedera:testnet',
    })),
    getSupported: vi.fn(async (): Promise<SupportedResponse> => ({
      kinds: [{ x402Version: 2, scheme: 'exact', network: 'hedera:testnet', extra: { feePayer: FEE_PAYER } }],
      extensions: [],
      signers: { 'hedera:*': [FEE_PAYER] },
    })),
  };
}

function buildResourceServer(facilitatorClient: FacilitatorClient) {
  return new x402ResourceServer(facilitatorClient).register(
    'hedera:testnet',
    new ExactHederaScheme({ defaultAssets: { 'hedera:testnet': { asset: HEDERA_TESTNET_USDC, decimals: 6 } } }),
  );
}

function fakeGraphClient(fetchImpl: typeof fetch): GraphClient {
  return { subgraphUrl: '', apiKey: '', fetch: fetchImpl };
}

describe('puerta x402 sobre Hedera', () => {
  const originalPayTo = process.env.GATE_PAYTO_ACCOUNT_ID;

  beforeEach(() => {
    // buildPaymentRoutes lee GATE_PAYTO_ACCOUNT_ID dentro de la función (no al cargar el módulo);
    // el test le da una cuenta de mentira, nunca usada para pagar de verdad.
    process.env.GATE_PAYTO_ACCOUNT_ID = '0.0.500000';
  });

  afterEach(() => {
    if (originalPayTo === undefined) delete process.env.GATE_PAYTO_ACCOUNT_ID;
    else process.env.GATE_PAYTO_ACCOUNT_ID = originalPayTo;
  });

  it('responde 402 sin pago, con el middleware real de @x402/hono y un facilitador falso inyectado', async () => {
    const facilitatorClient = fakeFacilitatorClient();
    const neverCalled = (async () => {
      throw new Error('el handler no debería ejecutarse sin pago');
    }) as unknown as typeof fetch;
    const app = createGateApp(buildResourceServer(facilitatorClient), fakeGraphClient(neverCalled));

    const res = await app.request('/tools/token_price?contract=0xa');

    expect(res.status).toBe(402);
    expect(facilitatorClient.verify).not.toHaveBeenCalled();
  });

  it('una petición pagada cuyo runTool lanza devuelve error y no liquida nada', async () => {
    const facilitatorClient = fakeFacilitatorClient();
    const brokenFetch = (async () => {
      throw new Error('The Graph no responde');
    }) as unknown as typeof fetch;
    const app = createGateApp(buildResourceServer(facilitatorClient), fakeGraphClient(brokenFetch));

    // Primera petición sin pago, solo para leer las payment requirements reales que la puerta anunció.
    const unpaid = await app.request('/tools/token_price?contract=0xa');
    const requiredHeader = unpaid.headers.get('payment-required');
    expect(requiredHeader).toBeTruthy();
    const required = decodePaymentRequiredHeader(requiredHeader!);
    const accepted = required.accepts[0];
    expect(accepted).toBeDefined();

    const paymentPayload = {
      x402Version: required.x402Version,
      accepted,
      payload: { transaction: 'ZmFrZQ==' },
    };
    const paidHeader = encodePaymentSignatureHeader(paymentPayload as never);

    const res = await app.request('/tools/token_price?contract=0xa', {
      headers: { 'PAYMENT-SIGNATURE': paidHeader },
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(facilitatorClient.verify).toHaveBeenCalledTimes(1);
    expect(facilitatorClient.settle).not.toHaveBeenCalled();
  });
});

// Hallazgo crítico 2 de la revisión de rama completa: antes de este arreglo,
// `buildGraphClientFromEnv` defaulteaba en silencio a `''` cuando faltaba GRAPH_SUBGRAPH_URL
// o GRAPH_API_KEY, así que la puerta arrancaba "bien" y solo fallaba de forma confusa en la
// primera consulta. Debe lanzar nombrando la variable que falta, igual que `liveSettleDeps`
// (arc/treasury.ts) y `liveAtsDeps` (hedera/ats.ts) ya hacen para sus propias credenciales.
describe('buildGraphClientFromEnv', () => {
  const originalUrl = process.env.GRAPH_SUBGRAPH_URL;
  const originalKey = process.env.GRAPH_API_KEY;

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.GRAPH_SUBGRAPH_URL;
    else process.env.GRAPH_SUBGRAPH_URL = originalUrl;
    if (originalKey === undefined) delete process.env.GRAPH_API_KEY;
    else process.env.GRAPH_API_KEY = originalKey;
  });

  it('lanza nombrando GRAPH_SUBGRAPH_URL si falta', () => {
    delete process.env.GRAPH_SUBGRAPH_URL;
    process.env.GRAPH_API_KEY = 'una-clave';
    expect(() => buildGraphClientFromEnv()).toThrow(/GRAPH_SUBGRAPH_URL/);
  });

  it('lanza nombrando GRAPH_API_KEY si falta', () => {
    process.env.GRAPH_SUBGRAPH_URL = 'https://example.com/subgraph';
    delete process.env.GRAPH_API_KEY;
    expect(() => buildGraphClientFromEnv()).toThrow(/GRAPH_API_KEY/);
  });

  it('construye el cliente cuando ambas variables están presentes, sin defaultear a cadena vacía', () => {
    process.env.GRAPH_SUBGRAPH_URL = 'https://example.com/subgraph';
    process.env.GRAPH_API_KEY = 'una-clave';

    const client = buildGraphClientFromEnv();

    expect(client.subgraphUrl).toBe('https://example.com/subgraph');
    expect(client.apiKey).toBe('una-clave');
  });
});
