// El informe de un agente o el aviso de una tarea terminada no empiezan un turno (turns.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { reportKind, isAgentReport } = require('../src/main/turns');

test('se reconocen los informes de agentes y los avisos de tareas, y nada más', () => {
  assert.equal(reportKind({ request: '<agent-message from="a1">Hecho: 3 archivos</agent-message>' }), 'agent-message');
  assert.equal(reportKind({ prompt: '  \n<task-notification>\n<task-id>x</task-id>' }), 'task-notification');
  assert.equal(reportKind({ request: '<TASK-NOTIFICATION id="1">' }), 'task-notification');
  assert.equal(isAgentReport({ request: 'Arregla el formulario: <agent-message> no es un informe aquí' }), false);
  assert.equal(isAgentReport({ request: '<agent-messages>' }), false); // otra etiqueta
  assert.equal(isAgentReport({ prompt: 'hola' }), false);
  assert.equal(isAgentReport(null), false);
  // El texto largo (request) manda sobre el recortado (prompt).
  assert.equal(isAgentReport({ request: 'hola', prompt: '<agent-message>' }), false);
});
