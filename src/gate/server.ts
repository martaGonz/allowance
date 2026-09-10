import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { paymentMiddleware } from '@x402/hono';
import { x402ResourceServer, type FacilitatorClient } from '@x402/core/server';
import { HTTPFacilitatorClient } from '@x402/core/http';
import { ExactHederaScheme as ExactHederaServerScheme } from '@x402/hedera/exact/server';
import { TOOLS, runTool } from '../graph/tools.js';
import type { GraphClient } from '../graph/client.js';
import { buildPaymentRoutes, HEDERA_TESTNET_NETWORK, HEDERA_TESTNET_USDC } from './routes.js';

const GATE_PORT = 8402;
const BLOCKY402_FACILITATOR_URL = 'https://api.testnet.blocky402.com';

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
 * Nada de facilitador propio. La pista de Hedera exige liquidar a través del
 * facilitador Blocky402 (verificado en vivo: `GET https://api.testnet.blocky402.com/supported`
 * responde `{"x402Version":2,"scheme":"exact","network":"hedera:testnet","extra":{"feePayer":
 * "0.0.7162784"}}`, sin API key). `HTTPFacilitatorClient` (de `@x402/core/http`) ya implementa
 * `FacilitatorClient` en su totalidad — no hace falta adaptador propio, a diferencia del
 * facilitador local que este reemplaza. Construido aquí dentro, nunca al cargar el módulo.
 */
function buildBlocky402FacilitatorClient(): FacilitatorClient {
  const url = process.env.X402_FACILITATOR_URL ?? BLOCKY402_FACILITATOR_URL;
  return new HTTPFacilitatorClient({ url });
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
  const facilitatorClient = buildBlocky402FacilitatorClient();
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
