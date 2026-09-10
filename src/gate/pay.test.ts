import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { paymentMiddleware } from '@x402/hono';
import { x402ResourceServer, type FacilitatorClient } from '@x402/core/server';
import type { SupportedResponse, VerifyResponse, SettleResponse } from '@x402/core/types';
import type { RoutesConfig } from '@x402/core/http';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { ExactHederaScheme } from '@x402/hedera/exact/server';
import { PrivateKey } from '@x402/hedera';
import { payAndRetry } from './pay.js';
import { HEDERA_TESTNET_NETWORK, HEDERA_TESTNET_USDC } from './routes.js';
import { runTool } from '../graph/tools.js';
import type { GraphClient } from '../graph/client.js';

const FEE_PAYER = '0.0.999999';
const GATE_URL = 'http://localhost:8402/tools/token_price?contract=0xa';

describe('payAndRetry', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('si la primera respuesta no es 402, la devuelve tal cual y no toca el SDK de Hedera', async () => {
    // Sin HEDERA_ACCOUNT_ID/HEDERA_PRIVATE_KEY en el entorno: si esta rama tocara el
    // SDK de pago, fallaría por credenciales ausentes. No falla porque no lo toca.
    globalThis.fetch = vi.fn(async () => new Response('ya pagado antes', { status: 200 })) as unknown as typeof fetch;

    const result = await payAndRetry('http://localhost:8402/tools/token_price?contract=0xa', 2_000);

    expect(result).toEqual({ status: 200, body: 'ya pagado antes', txId: null });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('sin credenciales configuradas, una respuesta 402 real hace fallar el pago en vez de simularlo', async () => {
    delete process.env.HEDERA_ACCOUNT_ID;
    delete process.env.HEDERA_PRIVATE_KEY;
    globalThis.fetch = vi.fn(async () => new Response('pago requerido', { status: 402 })) as unknown as typeof fetch;

    await expect(payAndRetry('http://localhost:8402/tools/token_price?contract=0xa', 2_000)).rejects.toThrow(
      /HEDERA_ACCOUNT_ID/,
    );
  });
});

// --- Rama de pago real, sin red: firma localmente con createPartiallySignedTransferTransaction
// (congela con Client.forTestnet() y firma en local, sin someterse a la red — verificado en
// @x402/hedera dist/esm/index.mjs:157-171) y nunca somete ninguna transacción. Solo se stubea
// `fetch` para simular las dos respuestas HTTP de la puerta; nada llega a Hedera de verdad.

function fakeFacilitatorClient(): FacilitatorClient {
  return {
    verify: vi.fn(async (): Promise<VerifyResponse> => ({ isValid: true, payer: '0.0.1001' })),
    settle: vi.fn(async (): Promise<SettleResponse> => ({
      success: true,
      transaction: 'no-debería-usarse-en-esta-prueba',
      network: HEDERA_TESTNET_NETWORK,
    })),
    getSupported: vi.fn(async (): Promise<SupportedResponse> => ({
      kinds: [{ x402Version: 2, scheme: 'exact', network: HEDERA_TESTNET_NETWORK, extra: { feePayer: FEE_PAYER } }],
      extensions: [],
      signers: { 'hedera:*': [FEE_PAYER] },
    })),
  };
}

function buildResourceServer(): x402ResourceServer {
  return new x402ResourceServer(fakeFacilitatorClient()).register(
    HEDERA_TESTNET_NETWORK,
    new ExactHederaScheme({ defaultAssets: { [HEDERA_TESTNET_NETWORK]: { asset: HEDERA_TESTNET_USDC, decimals: 6 } } }),
  );
}

const inertGraphClient: GraphClient = {
  subgraphUrl: '',
  apiKey: '',
  fetch: (async () => {
    throw new Error('esta prueba nunca debería intentar tocar The Graph');
  }) as unknown as typeof fetch,
};

// Réplica mínima de createGateApp, pero con rutas inyectables: para la prueba hostil (C.3)
// hace falta anunciar dos `accepts` para la misma ruta, algo que buildPaymentRoutes nunca
// produce (siempre exactamente una oferta por herramienta), así que aquí se construye a mano.
function buildAppWithRoutes(routes: RoutesConfig): Hono {
  const app = new Hono();
  app.use(paymentMiddleware(routes, buildResourceServer()));
  app.get('/tools/:name', async (c) => {
    const name = c.req.param('name');
    const args = Object.fromEntries(new URL(c.req.url).searchParams);
    const data = await runTool(name, args, inertGraphClient);
    return c.json(data);
  });
  return app;
}

/** Obtiene la cabecera PAYMENT-REQUIRED real que la puerta (con estas rutas) anuncia. */
async function unpaid402Header(routes: RoutesConfig): Promise<string> {
  const app = buildAppWithRoutes(routes);
  const res = await app.request('/tools/token_price?contract=0xa');
  const header = res.headers.get('payment-required');
  if (!header) throw new Error('la app de prueba no devolvió PAYMENT-REQUIRED');
  return header;
}

function singleOfferRoutes(amount: string): RoutesConfig {
  return {
    'GET /tools/token_price': {
      accepts: {
        scheme: 'exact',
        network: HEDERA_TESTNET_NETWORK,
        price: { asset: HEDERA_TESTNET_USDC, amount },
        payTo: '0.0.500000',
      },
    },
  };
}

/**
 * Cabecera PAYMENT-REQUIRED hostil, construida a mano con el codificador de
 * `@x402/core/http` (sin pasar por `x402ResourceServer`, que rechazaría anunciar un
 * scheme que su propio servidor no tiene registrado). Dos ofertas para la misma ruta:
 *
 * 1. `{ scheme: 'upto', amount: '2000' }` — mismo activo/red que exige el guard de
 * `payAndRetry`, y el importe que sí se autorizó. El guard de `payAndRetry` solo
 * mira red+activo (nunca `scheme`), así que `.find()` encuentra esta primero y la
 * valida como buena.
 * 2. `{ scheme: 'exact', amount: '999999' }` — la única oferta con el scheme que el
 * cliente x402 de `payAndRetry` tiene registrado (`ExactHederaScheme` bajo `'exact'`).
 *
 * `x402Client.createPaymentPayload` filtra primero por scheme registrado (@x402/core,
 * dist/esm/client/index.mjs:399-404: `supportedPaymentRequirements`) antes de aplicar
 * ningún control de gasto o el selector por defecto (`accepts[0]`). Con el `accepts`
 * completo (sin acotar), la oferta 1 (la que el guard validó) desaparece por scheme no
 * registrado, y la oferta 2 (999999, nunca comprobada) es la única que sobrevive: eso es
 * lo que firma y envía el código anterior a este arreglo. Con `accepts` acotado a
 * exactamente la oferta validada (el arreglo de este round), la oferta 1 acotada sola no
 * tiene ningún scheme registrado que la firme y `createPaymentPayload` lanza: no se firma
 * ni se envía nada.
 */
function hostileSchemeMismatchHeader(): string {
  const base = {
    network: HEDERA_TESTNET_NETWORK,
    asset: HEDERA_TESTNET_USDC,
    payTo: '0.0.500000',
    maxTimeoutSeconds: 300,
  };
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: { url: GATE_URL },
    accepts: [
      { ...base, scheme: 'upto', amount: '2000', extra: {} },
      { ...base, scheme: 'exact', amount: '999999', extra: { feePayer: FEE_PAYER } },
    ],
  };
  return encodePaymentRequiredHeader(paymentRequired);
}

describe('payAndRetry paga de verdad, sin red (firma local, nada se somete a Hedera)', () => {
  const originalFetch = globalThis.fetch;
  const originalPayTo = process.env.GATE_PAYTO_ACCOUNT_ID;
  const originalAccountId = process.env.HEDERA_ACCOUNT_ID;
  const originalPrivateKey = process.env.HEDERA_PRIVATE_KEY;

  beforeEach(() => {
    process.env.GATE_PAYTO_ACCOUNT_ID = '0.0.500000';
    process.env.HEDERA_ACCOUNT_ID = '0.0.1001';
    // Clave ECDSA generada en el momento, solo para firmar localmente en la prueba; no paga nada de verdad.
    process.env.HEDERA_PRIVATE_KEY = `0x${PrivateKey.generateECDSA().toStringRaw()}`;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalPayTo === undefined) delete process.env.GATE_PAYTO_ACCOUNT_ID;
    else process.env.GATE_PAYTO_ACCOUNT_ID = originalPayTo;
    if (originalAccountId === undefined) delete process.env.HEDERA_ACCOUNT_ID;
    else process.env.HEDERA_ACCOUNT_ID = originalAccountId;
    if (originalPrivateKey === undefined) delete process.env.HEDERA_PRIVATE_KEY;
    else process.env.HEDERA_PRIVATE_KEY = originalPrivateKey;
  });

  it('paga 2000: la cabecera PAYMENT-SIGNATURE enviada firma exactamente lo cotizado, y el txId sale de PAYMENT-RESPONSE', async () => {
    const requiredHeader = await unpaid402Header(singleOfferRoutes('2000'));
    let secondCallHeaders: HeadersInit | undefined;

    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const fn = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
      if (fn.mock.calls.length === 1) {
        return new Response('pago requerido', { status: 402, headers: { 'PAYMENT-REQUIRED': requiredHeader } });
      }
      secondCallHeaders = init?.headers;
      const settleHeader = encodePaymentResponseHeader({
        success: true,
        transaction: '0.0.1@1.0',
        network: HEDERA_TESTNET_NETWORK,
      });
      return new Response('{"priceUsd":1}', { status: 200, headers: { 'PAYMENT-RESPONSE': settleHeader } });
    }) as unknown as typeof fetch;

    const result = await payAndRetry(GATE_URL, 2_000);

    expect(result.status).toBe(200);
    expect(result.txId).toBe('0.0.1@1.0');
    const sentSignature = new Headers(secondCallHeaders).get('PAYMENT-SIGNATURE');
    expect(sentSignature).toBeTruthy();
    const sentPayload = decodePaymentSignatureHeader(sentSignature!);
    expect(sentPayload.accepted.amount).toBe('2000');
    expect(sentPayload.accepted.asset).toBe(HEDERA_TESTNET_USDC);
  });

  it('la puerta cotiza 2001 mientras se autorizaron 2000: payAndRetry lanza y nunca hace la segunda petición', async () => {
    const requiredHeader = await unpaid402Header(singleOfferRoutes('2001'));
    const fetchMock = vi.fn(async () => new Response('pago requerido', { status: 402, headers: { 'PAYMENT-REQUIRED': requiredHeader } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(payAndRetry(GATE_URL, 2_000)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gate hostil: el guard valida una oferta de 2000 pero solo hay firma disponible para otra de 999999 — nunca se firma ni se envía', async () => {
    const requiredHeader = hostileSchemeMismatchHeader();
    const fetchMock = vi.fn(async (_url?: string | URL | Request, _init?: RequestInit) =>
      new Response('pago requerido', { status: 402, headers: { 'PAYMENT-REQUIRED': requiredHeader } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // No se asume si payAndRetry lanza o resuelve (la puerta falsa de esta prueba siempre
    // devuelve 402, para poder inspeccionar qué cabecera de pago se intentó enviar en cualquier
    // segunda llamada, en vez de necesitar simular una liquidación). Lo único que importa es la
    // invariante: nunca sale una PAYMENT-SIGNATURE que firme 999999.
    await payAndRetry(GATE_URL, 2_000).catch(() => undefined);

    const sentAmounts: string[] = [];
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      const signature = new Headers(init?.headers).get('PAYMENT-SIGNATURE');
      if (!signature) continue;
      sentAmounts.push(decodePaymentSignatureHeader(signature).accepted.amount);
    }
    expect(sentAmounts).not.toContain('999999');
  });

  // Hallazgo crítico 1 de la revisión de rama completa: `@x402/hono` solo liquida en 2xx. Un
  // 402 real de la puerta (`payAndRetry` primera respuesta) nunca llega aquí — ya lanza antes
  // (prueba "sin credenciales..." más arriba). Lo que faltaba cubrir es el REINTENTO ya
  // pagado: si ese reintento no es 2xx, o es 2xx pero sin PAYMENT-RESPONSE, nada se liquidó de
  // verdad en Hedera y el envoltorio no puede devolverlo como si fuera un pago exitoso.
  it('el reintento pagado responde 500: payAndRetry lanza en vez de devolver el error como pago', async () => {
    const requiredHeader = await unpaid402Header(singleOfferRoutes('2000'));
    globalThis.fetch = vi.fn(async () => {
      const fn = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
      if (fn.mock.calls.length === 1) {
        return new Response('pago requerido', { status: 402, headers: { 'PAYMENT-REQUIRED': requiredHeader } });
      }
      return new Response('error interno', { status: 500 });
    }) as unknown as typeof fetch;

    await expect(payAndRetry(GATE_URL, 2_000)).rejects.toThrow(/500/);
  });

  it('el reintento pagado responde 402 (la puerta lo rechazó otra vez): payAndRetry lanza', async () => {
    const requiredHeader = await unpaid402Header(singleOfferRoutes('2000'));
    globalThis.fetch = vi.fn(async () => {
      const fn = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
      if (fn.mock.calls.length === 1) {
        return new Response('pago requerido', { status: 402, headers: { 'PAYMENT-REQUIRED': requiredHeader } });
      }
      return new Response('pago requerido de nuevo', { status: 402 });
    }) as unknown as typeof fetch;

    await expect(payAndRetry(GATE_URL, 2_000)).rejects.toThrow(/402/);
  });

  it('el reintento pagado responde 200 pero sin cabecera PAYMENT-RESPONSE: el middleware no liquidó, payAndRetry lanza', async () => {
    const requiredHeader = await unpaid402Header(singleOfferRoutes('2000'));
    globalThis.fetch = vi.fn(async () => {
      const fn = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
      if (fn.mock.calls.length === 1) {
        return new Response('pago requerido', { status: 402, headers: { 'PAYMENT-REQUIRED': requiredHeader } });
      }
      return new Response('{"priceUsd":1}', { status: 200 });
    }) as unknown as typeof fetch;

    await expect(payAndRetry(GATE_URL, 2_000)).rejects.toThrow(/PAYMENT-RESPONSE/);
  });

  it('el reintento pagado trae una PAYMENT-RESPONSE que no decodifica: no lanza, txId es null y receiptError explica por qué', async () => {
    const requiredHeader = await unpaid402Header(singleOfferRoutes('2000'));
    globalThis.fetch = vi.fn(async () => {
      const fn = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
      if (fn.mock.calls.length === 1) {
        return new Response('pago requerido', { status: 402, headers: { 'PAYMENT-REQUIRED': requiredHeader } });
      }
      return new Response('{"priceUsd":1}', {
        status: 200,
        headers: { 'PAYMENT-RESPONSE': 'esto-no-es-una-cabecera-valida-@@@' },
      });
    }) as unknown as typeof fetch;

    const result = await payAndRetry(GATE_URL, 2_000);

    expect(result.status).toBe(200);
    expect(result.txId).toBeNull();
    expect(result.receiptError).toBeTruthy();
  });
});
