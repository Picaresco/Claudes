// Servidor MCP mínimo (JSON-RPC sobre HTTP) con el que Claudes ofrece herramientas
// propias a las sesiones de Claude. Solo implementa lo necesario para herramientas:
// initialize, ping, tools/list y tools/call.
const DEFAULT_PROTOCOL = '2025-06-18';

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// tools: [{ name, description, inputSchema }]
// callTool(tabId, name, args) → Promise<string> con el texto del resultado (o lanza un error).
function createMcp({ name, version, tools, callTool }) {
  async function handleMessage(tabId, message) {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return message && message.id !== undefined ? fail(message.id, -32600, 'Invalid Request') : null;
    }
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    switch (method) {
      case 'initialize': {
        const requested = params && params.protocolVersion;
        return ok(id, {
          protocolVersion: /^\d{4}-\d{2}-\d{2}$/.test(requested || '') ? requested : DEFAULT_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name, version },
        });
      }
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools });
      case 'tools/call': {
        const toolName = params && params.name;
        if (!tools.some((tool) => tool.name === toolName)) return fail(id, -32602, `Unknown tool: ${toolName}`);
        try {
          const text = await callTool(tabId, toolName, (params && params.arguments) || {});
          return ok(id, { content: [{ type: 'text', text }], isError: false });
        } catch (err) {
          // Un fallo de la herramienta se devuelve como resultado, para que Claude lo lea.
          return ok(id, { content: [{ type: 'text', text: String((err && err.message) || err) }], isError: true });
        }
      }
      default:
        return isNotification ? null : fail(id, -32601, `Method not found: ${method}`);
    }
  }

  // Devuelve { status, json }: json es undefined cuando no hay nada que responder (avisos).
  return async function handle(tabId, body) {
    if (Array.isArray(body)) {
      const results = (await Promise.all(body.map((message) => handleMessage(tabId, message)))).filter(Boolean);
      return results.length ? { status: 200, json: results } : { status: 202 };
    }
    const result = await handleMessage(tabId, body);
    return result ? { status: 200, json: result } : { status: 202 };
  };
}

module.exports = { createMcp };
