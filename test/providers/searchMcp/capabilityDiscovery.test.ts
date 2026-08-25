import { describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createSearchMcpClientWithTransport } from '../../../src/providers/searchMcp/client.js';
import {
  createSearchMcpProviderFromClient,
  capabilitiesFromToolNames,
} from '../../../src/providers/searchMcp/index.js';

describe('dynamic capability discovery', () => {
  it('createSearchMcpClientWithTransport retains the discovered tool names', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: 'subset-test', version: '1.0.0' }, { capabilities: { tools: {} } });
    // Deliberate SUBSET — no 'research' (academic), no 'github'
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: 'web_search', inputSchema: { type: 'object' } },
        { name: 'web_crawl', inputSchema: { type: 'object' } },
        { name: 'youtube', inputSchema: { type: 'object' } },
      ],
    }));
    await server.connect(serverTransport);

    const client = await createSearchMcpClientWithTransport(clientTransport);
    expect([...client.toolNames].sort()).toEqual(['web_crawl', 'web_search', 'youtube']);

    // Wrap to observe whether provider.close() reaches the underlying client
    let closed = false;
    const observedClient = {
      ...client,
      close: async () => { closed = true; await client.close(); },
    };
    const provider = createSearchMcpProviderFromClient(observedClient, client.toolNames);
    // Reflects the ACTUAL subset, not the old hardcoded set
    expect(provider.capabilities.search).toBe(true);
    expect(provider.capabilities.read).toBe(true);
    expect(provider.capabilities.media).toBe(true);
    expect(provider.capabilities.academic).toBe(false);
    expect(provider.capabilities.code).toBe(false);
    expect(provider.capabilities.browser).toBe(false);

    // provider.close() delegates to the underlying client's close()
    await provider.close!();
    expect(closed).toBe(true);
    await server.close();
  });

  it('capabilitiesFromToolNames maps known tool names to capability flags', () => {
    const caps = capabilitiesFromToolNames(['web_search', 'web_crawl', 'github', 'reddit']);
    expect(caps.search).toBe(true);
    expect(caps.read).toBe(true);
    expect(caps.code).toBe(true);
    expect(caps.community.reddit).toBe(true);
    expect(caps.academic).toBe(false);
  });

  it('throws a clear startup error when the minimum usable set is missing', () => {
    expect(() => capabilitiesFromToolNames(['youtube', 'reddit']))
      .toThrow(/missing required tool\(s\): web_search, web_crawl/);
    expect(() => capabilitiesFromToolNames(['web_search']))
      .toThrow(/web_crawl/);
    expect(() => capabilitiesFromToolNames([]))
      .toThrow(/Discovered tools: \(none\)/);
  });
});
