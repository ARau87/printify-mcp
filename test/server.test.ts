import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { createServer } from '../src/server.js';

describe('createServer', () => {
  it('answers initialize with the printify-mcp server info', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const received: JSONRPCMessage[] = [];
    clientSide.onmessage = (message) => {
      received.push(message);
    };

    await createServer().connect(serverSide);
    await clientSide.start();
    await clientSide.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '0' },
      },
    });

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });
    expect(received[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { serverInfo: { name: 'printify-mcp', version: '0.0.0' } },
    });

    await clientSide.close();
  });
});
