import { describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createSearchMcpProviderFromClient } from '../../../src/providers/searchMcp/index.js';
import { createSearchMcpClientWithTransport } from '../../../src/providers/searchMcp/client.js';
import type { ProviderCallContext } from '../../../src/providers/types.js';

describe('SearchMcpClient cancellation boundary', () => {
  it('rejects in-flight call when signal aborts', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: 'slow-test', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'slow', inputSchema: { type: 'object' } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { content: [{ type: 'text', text: '{}' }] };
    });
    await server.connect(serverTransport);
    const client = await createSearchMcpClientWithTransport(clientTransport);
    const controller = new AbortController();
    const call = client.callTool('slow', {}, { signal: controller.signal, deadlineAt: Date.now() + 5_000 });
    setTimeout(() => controller.abort(), 10);
    await expect(call).rejects.toBeDefined();
    await client.close();
    await server.close();
  });

  it('rejects when absolute deadline expires', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: 'deadline-test', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'slow', inputSchema: { type: 'object' } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { content: [{ type: 'text', text: '{}' }] };
    });
    await server.connect(serverTransport);
    const client = await createSearchMcpClientWithTransport(clientTransport);
    await expect(client.callTool('slow', {}, { signal: new AbortController().signal, deadlineAt: Date.now() + 10 }))
      .rejects.toBeDefined();
    await client.close();
    await server.close();
  });

  it('provider.search rejects in-flight call when context signal aborts', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: 'slow-test', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'slow', inputSchema: { type: 'object' } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { content: [{ type: 'text', text: '{}' }] };
    });
    await server.connect(serverTransport);
    const client = await createSearchMcpClientWithTransport(clientTransport);
    const provider = createSearchMcpProviderFromClient(client, ['web_search']);
    const controller = new AbortController();
    const providerCtx: ProviderCallContext = {
      signal: controller.signal,
      runId: 'cancellation-test',
      deadlineAt: Date.now() + 5_000,
      trace: { traceId: 'cancellation-test', spanId: 'cancellation-test' },
    };
    const call = provider.search(providerCtx, 'test query', undefined);
    setTimeout(() => controller.abort(), 10);

    await expect(call).rejects.toBeDefined();
    await client.close();
    await server.close();
  });
});
