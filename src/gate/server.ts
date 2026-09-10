import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { paymentMiddleware } from '@x402/hono';
import { x402ResourceServer, type FacilitatorClient } from '@x402/core/server';
import type { SupportedResponse } from '@x402/core/types';
import { x402Facilitator } from '@x402/core/facilitator';
import { ExactHederaScheme as ExactHederaServerScheme } from '@x402/hedera/exact/server';
import { ExactHederaScheme as ExactHederaFacilitatorScheme } from '@x402/hedera/exact/facilitator';
import {
  PrivateKey,
  createHederaClient,
  createHederaSignAndSubmitTransaction,
  createHederaVerifyPayerSignature,
  createHederaPreflightTransfer,
  type FacilitatorHederaSigner,
} from '@x402/hedera';
import { TOOLS, runTool } from '../graph/tools.js';
import type { GraphClient } from '../graph/client.js';
import { buildPaymentRoutes, HEDERA_TESTNET_NETWORK, HEDERA_TESTNET_USDC } from './routes.js';

const GATE_PORT = 8402;

/**
 * El núcleo testeable de la puerta: monta el middleware x402 real
 * (`@x402/hono`) sobre las rutas de `buildPaymentRoutes` y sirve `runTool`
 * detrás de él. No construye nada del SDK: recibe el `x402ResourceServer`
 * ya configurado (con su facilitador, real o falso) desde quien la llama,
 * para que los tests puedan inyectar un facilitador falso sin
 * tocar Hedera, y el arranque de producción pueda inyectar el real.
 */
export function createGateApp(resourceServer: x402ResourceServer, client: GraphClient): Hono {
  const app = new Hono();
  const routes = buildPaymentRoutes(TOOLS);

  app.use(paymentMiddleware(routes, resourceServer));

  app.get('/tools/:name', async (c) => {
    const name = c.req.param('name');
    const args = Object.fromEntries(new URL(c.req.url).searchParams);
    const data = await runTool(name, args, client);
    return c.json(data);
  });

  return app;
}

/**
 * Facilitador propio en local: firma con la cuenta del
 * FACILITATOR_*, nunca con la del payer ni un facilitador de terceros.
 * Las claves se leen aquí dentro, no al cargar el módulo.
 */
function buildFacilitatorSigner(): FacilitatorHederaSigner {
  const accountId = process.env.FACILITATOR_ACCOUNT_ID;
  const privateKeyHex = process.env.FACILITATOR_PRIVATE_KEY;
  if (!accountId || !privateKeyHex) {
    throw new Error('FACILITATOR_ACCOUNT_ID/FACILITATOR_PRIVATE_KEY no configuradas: la puerta no puede liquidar pagos');
  }
  const feePayerKey = PrivateKey.fromStringECDSA(privateKeyHex);
  return {
    getAddresses: () => [accountId],
    signAndSubmitTransaction: createHederaSignAndSubmitTransaction(
      (network) => createHederaClient(network),
      feePayerKey,
    ),
    verifyPayerSignature: createHederaVerifyPayerSignature(),
    preflightTransfer: createHederaPreflightTransfer(),
  };
}

/**
 * Adapta el `x402Facilitator` local (verify/settle en proceso, sin red
 * intermediaria) a la interfaz `FacilitatorClient` que pide
 * `x402ResourceServer`. Este adaptador vive en el arranque del servidor,
 * nunca dentro de `createGateApp`.
 */
function buildLocalFacilitatorClient(): FacilitatorClient {
  const signer = buildFacilitatorSigner();
  const facilitator = new x402Facilitator().register(
    HEDERA_TESTNET_NETWORK,
    new ExactHederaFacilitatorScheme(signer, { aliasPolicy: 'reject' }),
  );
  return {
    verify: (paymentPayload, paymentRequirements) => facilitator.verify(paymentPayload, paymentRequirements),
    settle: (paymentPayload, paymentRequirements) => facilitator.settle(paymentPayload, paymentRequirements),
    // x402Facilitator.getSupported() (paquete @x402/core) tipa `kinds[].network` como
    // `string` en vez del `Network` de marca `${string}:${string}` que exige
    // `SupportedResponse` — ver informe: defecto de tipos reportado, no de comportamiento.
    getSupported: async (): Promise<SupportedResponse> => facilitator.getSupported() as unknown as SupportedResponse,
  };
}

function buildResourceServer(facilitatorClient: FacilitatorClient): x402ResourceServer {
  return new x402ResourceServer(facilitatorClient).register(
    HEDERA_TESTNET_NETWORK,
    new ExactHederaServerScheme({
      defaultAssets: { [HEDERA_TESTNET_NETWORK]: { asset: HEDERA_TESTNET_USDC, decimals: 6 } },
    }),
  );
}

function buildGraphClientFromEnv(): GraphClient {
  return {
    subgraphUrl: process.env.GRAPH_SUBGRAPH_URL ?? '',
    tokenApiUrl: process.env.GRAPH_TOKEN_API_URL ?? '',
    apiKey: process.env.GRAPH_API_KEY ?? '',
    fetch: globalThis.fetch,
  };
}

async function main(): Promise<void> {
  const facilitatorClient = buildLocalFacilitatorClient();
  const resourceServer = buildResourceServer(facilitatorClient);
  const client = buildGraphClientFromEnv();
  const app = createGateApp(resourceServer, client);
  serve({ fetch: app.fetch, port: GATE_PORT });
  console.log(`puerta x402 escuchando en :${GATE_PORT}`);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
