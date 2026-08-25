// Test-fixture MCP server: same surface as echo-mcp, but tools/call never
// responds (simulates a hung tool). Keeps the event loop alive on purpose.
import { createInterface } from 'node:readline';

const keepAlive = setInterval(() => {}, 1 << 30);

createInterface({ input: process.stdin }).on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
        msg = JSON.parse(trimmed);
    } catch {
        return;
    }
    if (msg.id === undefined || msg.id === null) return;
    if (msg.method === 'close') {
        clearInterval(keepAlive);
        process.exit(0);
    }
    if (msg.method === 'tools/call') return; // Hang: never reply.

    const { id, method } = msg;
    if (method === 'initialize') {
        reply(id, {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'hang-mcp', version: '1.0.0' },
        });
    } else if (method === 'tools/list') {
        reply(id, { tools: [{ name: 'hang', description: 'Never responds', inputSchema: { type: 'object' } }] });
    } else {
        reply(id, undefined, { code: -32601, message: `Method not found: ${method}` });
    }
});

function reply(id, result, error) {
    const res = { jsonrpc: '2.0', id };
    if (error) res.error = error;
    else res.result = result;
    process.stdout.write(JSON.stringify(res) + '\n');
}
