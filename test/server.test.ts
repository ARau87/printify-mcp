import { readFileSync } from 'node:fs';
import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { createServer } from '../src/server.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };

async function connect() {
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
  return { clientSide, received };
}

describe('createServer', () => {
  it('answers initialize with the name and version from package.json', async () => {
    const { clientSide, received } = await connect();
    expect(received[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        serverInfo: { name: packageJson.name, version: packageJson.version },
        capabilities: { tools: { listChanged: false } },
      },
    });
    await clientSide.close();
  });

  it('answers tools/list with an empty list', async () => {
    const { clientSide, received } = await connect();
    await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await clientSide.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await vi.waitFor(() => {
      expect(received).toHaveLength(2);
    });
    expect(received[1]).toEqual({ jsonrpc: '2.0', id: 2, result: { tools: [] } });
    await clientSide.close();
  });
});
