// ── ¿Empieza un turno nuevo? ─────────────────────────────────────
// Claude Code le pasa a Claude como un mensaje (UserPromptSubmit) el informe de un agente que
// trabajaba en segundo plano o el aviso de una tarea que ha terminado. No lo ha escrito el usuario
// y no empieza un turno nuevo: lo que el turno lleva hecho (código cambiado, pruebas pendientes,
// revisión de Codex, pasada final de SuperPowers) sigue contando.
const REPORT = /^\s*<(agent-message|task-notification)[\s>]/i;

// 'agent-message' | 'task-notification' | null, según lo que diga el mensaje.
function reportKind(event) {
  const said = String((event && (event.request || event.prompt)) || '');
  const match = REPORT.exec(said);
  return match ? match[1].toLowerCase() : null;
}

const isAgentReport = (event) => Boolean(reportKind(event));

module.exports = { REPORT, reportKind, isAgentReport };
