import {
  InMemoryTransport,
  type JSONRPCMessage,
  type McpServer,
} from '@modelcontextprotocol/server';

type Result = Record<string, unknown>;

export interface RawMcpClient {
  /** The result of `initialize`. */
  initialized: Result;
  listTools(): Promise<Result[]>;
  callTool(name: string, args: Result): Promise<Result>;
  close(): Promise<void>;
}

/**
 * Connects to `server` over an in-memory transport and completes the initialize handshake. It
 * speaks raw JSON-RPC until #6 brings the MCP `Client`.
 */
export async function connect(server: McpServer): Promise<RawMcpClient> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const waiting = new Map<string | number, (message: JSONRPCMessage) => void>();
  clientSide.onmessage = (message) => {
    if ('id' in message && message.id !== undefined) waiting.get(message.id)?.(message);
  };
  await server.connect(serverSide);
  await clientSide.start();

  let nextId = 1;
  async function request(method: string, params: Result): Promise<Result> {
    const id = nextId;
    nextId += 1;
    const reply = new Promise<JSONRPCMessage>((resolve) => {
      waiting.set(id, resolve);
    });
    await clientSide.send({ jsonrpc: '2.0', id, method, params });
    const message = await reply;
    if (!('result' in message)) throw new Error(`${method} failed: ${JSON.stringify(message)}`);
    return message.result;
  }

  const initialized = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return {
    initialized,
    listTools: async () => (await request('tools/list', {})).tools as Result[],
    callTool: (name, args) => request('tools/call', { name, arguments: args }),
    close: () => clientSide.close(),
  };
}
