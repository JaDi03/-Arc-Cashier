// Test-fixture MCP server: newline-delimited JSON-RPC 2.0 over stdio.
// Responds to initialize, ping, tools/list, and echoes tools/call arguments
// back as text content after ~50ms.
import { createInterface } from 'node:readline';

createInterface({ input: process.stdin }).on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
        msg = JSON.parse(trimmed);
    } catch {
        return;
    }
    if (msg.id === undefined || msg.id === null) return; // Notifications: ignore.

    const { id, method, params = {} } = msg;
    if (method === 'initialize') {
        reply(id, {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'echo-mcp', version: '1.0.0' },
        });
    } else if (method === 'ping') {
        reply(id, {});
    } else if (method === 'tools/list') {
        reply(id, {
            tools: [{ name: 'echo', description: 'Echoes arguments back', inputSchema: { type: 'object' } }],
        });
    } else if (method === 'tools/call') {
        setTimeout(() => {
            reply(id, { content: [{ type: 'text', text: JSON.stringify(params.arguments ?? {}) }], isError: false });
        }, 50);
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
