import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { TOOLS, type ToolSpec } from '../graph/tools.js';
import { buildGateUrl } from './gate-url.js';

const GATE_URL = process.env.GATE_URL ?? 'http://localhost:8402';

function toolSpec(name: string): ToolSpec {
  const spec = TOOLS.find((t) => t.name === name);
  if (!spec) throw new Error(`herramienta desconocida en el catálogo: ${name}`);
  return spec;
}

const server = new McpServer({ name: 'allowance', version: '0.1.0' });

const tokenPriceSpec = toolSpec('token_price');
server.registerTool(
  'token_price',
  {
    description: `${tokenPriceSpec.description} Cuesta ${tokenPriceSpec.priceMicroUsdc / 1_000_000} USDC por llamada.`,
    inputSchema: { contract: z.string() },
  },
  async ({ contract }) => {
    const res = await fetch(buildGateUrl(GATE_URL, 'token_price', { contract }));
    const text = await res.text();
    return { content: [{ type: 'text', text: res.status === 402 ? `402 pago requerido: ${text}` : text }] };
  },
);

const positionStateSpec = toolSpec('position_state');
server.registerTool(
  'position_state',
  {
    description: `${positionStateSpec.description} Cuesta ${positionStateSpec.priceMicroUsdc / 1_000_000} USDC por llamada.`,
    inputSchema: { positionId: z.string() },
  },
  async ({ positionId }) => {
    const res = await fetch(buildGateUrl(GATE_URL, 'position_state', { positionId }));
    const text = await res.text();
    return { content: [{ type: 'text', text: res.status === 402 ? `402 pago requerido: ${text}` : text }] };
  },
);

await server.connect(new StdioServerTransport());
