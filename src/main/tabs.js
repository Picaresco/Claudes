// Lo que el proceso principal sabe de cada pestaña, en una sola tabla: así al cerrar
// una pestaña se olvida todo de una vez.
//
//   name     nombre de la pestaña, para que los registros se lean bien
//   folder   carpeta de su sesión
//   session  conversación de Claude que tiene abierta
//   log      registro de depuración de Claude de su último arranque
//   usage    último llenado de la conversación enviado a la interfaz
//   style    estilo de respuesta que ya conoce su sesión: 'explain', 'brief' o null (ninguno
//            todavía); undefined hasta que arranca una sesión
class Tabs {
  constructor() {
    this.map = new Map();
  }

  get(id) {
    return this.map.get(id);
  }

  // El registro de una pestaña; se crea la primera vez.
  ensure(id) {
    if (!this.map.has(id)) this.map.set(id, { name: null, folder: null, session: null, log: null, usage: null, style: undefined });
    return this.map.get(id);
  }

  forget(id) {
    this.map.delete(id);
  }

  // Cómo se nombra una pestaña en los registros. La terminal extra de la pestaña «x» es «x:sh».
  label(id) {
    const base = String(id).replace(/:sh$/, '');
    const tab = this.map.get(base);
    return `«${(tab && tab.name) || base}»${String(id).endsWith(':sh') ? ' (terminal extra)' : ''}`;
  }

  // Pestaña → conversación, de las que tienen una sesión.
  sessions() {
    const out = new Map();
    for (const [id, tab] of this.map) if (tab.session) out.set(id, tab.session);
    return out;
  }
}

module.exports = { Tabs };
