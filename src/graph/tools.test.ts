import { describe, it, expect } from 'vitest';
import { TOOLS, runTool } from './tools.js';

describe('catálogo de herramientas', () => {
  it('cada herramienta tiene precio positivo', () => {
    expect(TOOLS.length).toBeGreaterThan(1);
    for (const tool of TOOLS) expect(tool.priceMicroUsdc).toBeGreaterThan(0);
  });

  it('los precios no son todos iguales, para que decidir signifique algo', () => {
    const prices = new Set(TOOLS.map(t => t.priceMicroUsdc));
    expect(prices.size).toBeGreaterThan(1);
  });

  it('una herramienta desconocida no se ejecuta', async () => {
    const client = { subgraphUrl: '', tokenApiUrl: '', apiKey: '', fetch: globalThis.fetch };
    await expect(runTool('inventada', {}, client)).rejects.toThrow('herramienta desconocida: inventada');
  });
});
