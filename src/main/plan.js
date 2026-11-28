// ── Seguimiento del plan (panel «Actividad») ───────────────────────
// Los pasos que Claude apunta en su lista de tareas, con su estado: terminado, trabajando o
// pendiente. Claude Code trae esa lista apagada con los modelos nuevos; ClaudHome la enciende
// (CLAUDE_CODE_ENABLE_TODO_TOOLS) y le pide que la use en los trabajos de varios pasos (PLAN_NOTE).
//
// Se sigue con los avisos de Claude Code (hooks.js), no leyendo ~/.claude/tasks: así solo
// cuentan las tareas que apunta el hilo principal de esta conversación (no las de un agente
// ni las de otra sesión que comparta la lista). Con TaskCreate llega el número de la tarea en
// la respuesta; TaskUpdate la cambia o la borra; TodoWrite (modelos anteriores) trae la lista
// entera de una vez.
//
// «Plan actual»: las tareas apuntadas desde el último encargo. Si todas están terminadas y el
// usuario pide otra cosa, la siguiente tarea empieza un plan nuevo; si Claude añade un último
// paso dentro del mismo encargo, sigue siendo el mismo plan.

const MAX_STEPS = 60;
const MAX_TEXT = 140;

// Lo que ClaudHome le pide a Claude al empezar la sesión (va con el contexto del proyecto).
const PLAN_NOTE = [
  '# Plan de la tarea (ClaudHome)',
  'El usuario sigue tu trabajo en un panel de ClaudHome que enseña tu lista de tareas.',
  'En cualquier trabajo de tres pasos o más, antes de empezar apunta cada paso con TaskCreate (frases cortas, en español, en imperativo) y ve marcándolos con TaskUpdate: in_progress al empezar cada uno y completed en cuanto acabe, no al final. Un solo paso en curso a la vez.',
  'Si presentas un plan en modo planificación y el usuario lo aprueba, convierte sus puntos en tareas de la misma forma antes de empezar.',
  'No la uses para una pregunta ni para un cambio de un solo paso. Si no tienes cargadas TaskCreate y TaskUpdate, búscalas con ToolSearch.',
].join('\n');

const STATUS = { pending: 'todo', in_progress: 'work', completed: 'done' };
const clip = (text) => {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  return one.length > MAX_TEXT ? `${one.slice(0, MAX_TEXT - 1)}…` : one;
};

// send(canal, …): a la interfaz. now: reloj (pruebas).
function createPlanTracker({ send = () => {}, now = Date.now } = {}) {
  const plans = new Map(); // id de pestaña → estado

  const state = (tabId) => {
    if (!plans.has(tabId)) plans.set(tabId, { session: null, steps: [], newTask: false, at: 0 });
    return plans.get(tabId);
  };

  const view = (st) => {
    if (!st || !st.steps.length) return null;
    const steps = st.steps.map(({ id, text, status }) => ({ id, text, status }));
    return {
      steps,
      done: steps.filter((s) => s.status === 'done').length,
      total: steps.length,
      at: st.at,
    };
  };
  const changed = (tabId, st) => {
    st.at = now();
    send('plan:update', tabId, view(st));
  };

  const allDone = (st) => st.steps.length > 0 && st.steps.every((s) => s.status === 'done');

  function event(tabId, ev) {
    if (!ev || typeof ev.event !== 'string') return;
    const st = state(tabId);
    const narr = ev.narr || {};
    // Otra conversación en la pestaña (/clear, «Nueva conversación»): su plan empieza de cero.
    if (ev.sessionId && ev.sessionId !== st.session) {
      const had = st.steps.length > 0;
      if (st.session) { st.steps = []; st.newTask = false; }
      st.session = ev.sessionId;
      if (had && !st.steps.length) changed(tabId, st);
    }
    if (narr.agentId) return; // las tareas de un agente no son el plan de esta conversación
    if (ev.event === 'UserPromptSubmit') {
      if (ev.agentReport) return; // el informe de un agente no es un encargo nuevo (turns.js)
      // Un encargo nuevo: si el plan anterior ya estaba terminado, lo siguiente es otro plan.
      if (allDone(st)) st.newTask = true;
      return;
    }
    if (ev.event !== 'PostToolUse') return;
    const task = narr.task;
    if (ev.toolName === 'TaskCreate' && task && task.id) {
      if (st.newTask && allDone(st)) st.steps = [];
      st.newTask = false;
      if (!st.steps.some((s) => s.id === task.id) && st.steps.length < MAX_STEPS) {
        st.steps.push({ id: task.id, text: clip(task.subject) || `Paso ${task.id}`, status: 'todo' });
      }
      changed(tabId, st);
    } else if (ev.toolName === 'TaskUpdate' && task && task.id) {
      const step = st.steps.find((s) => s.id === task.id);
      if (!step) return; // de un plan anterior o de otra sesión
      if (task.status === 'deleted') st.steps = st.steps.filter((s) => s !== step);
      else {
        if (STATUS[task.status]) step.status = STATUS[task.status];
        if (task.subject) step.text = clip(task.subject);
      }
      changed(tabId, st);
    } else if (ev.toolName === 'TodoWrite' && narr.input && Array.isArray(narr.input.todos)) {
      st.steps = narr.input.todos.slice(0, MAX_STEPS).map((t, n) => ({
        id: `t${n + 1}`, text: clip(t.content) || `Paso ${n + 1}`, status: STATUS[t.status] || 'todo',
      }));
      st.newTask = false;
      changed(tabId, st);
    }
  }

  const get = (tabId) => view(plans.get(tabId));
  const forget = (tabId) => { plans.delete(tabId); };
  return { event, get, forget };
}

module.exports = { createPlanTracker, PLAN_NOTE };
