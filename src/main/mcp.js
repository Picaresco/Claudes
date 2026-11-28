// Servidor MCP mínimo (JSON-RPC sobre HTTP) con el que Claudes ofrece herramientas
// propias a las sesiones de Claude. Solo implementa lo necesario para herramientas:
// initialize, ping, tools/list y tools/call.
const DEFAULT_PROTOCOL = '2025-06-18';

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// tools: [{ name, description, inputSchema }], o una función (tabId) que la devuelve (se mira en
// cada tools/list y tools/call: cada pestaña puede tener las suyas). callTool(tabId, name, args,
// signal) → Promise con el texto del resultado, o { content } con texto e imágenes (o lanza un
// error); signal avisa si quien llamó deja de esperar.
function createMcp({ name, version, tools, callTool }) {
  const listTools = (tabId) => (typeof tools === 'function' ? tools(tabId) : tools);
  // Llamadas en curso, para pararlas si el cliente avisa de que las cancela.
  const active = new Map(); // `${tabId} ${id}` → AbortController

  async function handleMessage(tabId, message, signal) {
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
        return ok(id, { tools: listTools(tabId) });
      case 'tools/call': {
        const toolName = params && params.name;
        if (!listTools(tabId).some((tool) => tool.name === toolName)) return fail(id, -32602, `Unknown tool: ${toolName}`);
        const controller = new AbortController();
        const key = `${tabId} ${id}`;
        const onAbort = () => controller.abort();
        if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
        active.set(key, controller);
        try {
          const result = await callTool(tabId, toolName, (params && params.arguments) || {}, controller.signal);
          const content = result && typeof result === 'object' && Array.isArray(result.content) ? result.content : [{ type: 'text', text: String(result) }];
          return ok(id, { content, isError: false });
        } catch (err) {
          // Un fallo de la herramienta se devuelve como resultado, para que Claude lo lea.
          return ok(id, { content: [{ type: 'text', text: String((err && err.message) || err) }], isError: true });
        } finally {
          active.delete(key);
          if (signal) signal.removeEventListener('abort', onAbort);
        }
      }
      case 'notifications/cancelled': {
        const target = active.get(`${tabId} ${params && params.requestId}`);
        if (target) target.abort();
        return null;
      }
      default:
        return isNotification ? null : fail(id, -32601, `Method not found: ${method}`);
    }
  }

  // Devuelve { status, json }: json es undefined cuando no hay nada que responder (avisos).
  return async function handle(tabId, body, signal = null) {
    if (Array.isArray(body)) {
      const results = (await Promise.all(body.map((message) => handleMessage(tabId, message, signal)))).filter(Boolean);
      return results.length ? { status: 200, json: results } : { status: 202 };
    }
    const result = await handleMessage(tabId, body, signal);
    return result ? { status: 200, json: result } : { status: 202 };
  };
}

module.exports = { createMcp };
