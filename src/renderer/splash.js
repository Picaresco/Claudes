// Animación de arranque, «la casa se abre»: el icono de la carpeta se dibuja con un
// trazo de luz y se abre, de dentro salen volando tus pestañas hasta su sitio, aparece
// el nombre con un destello y carpeta y nombre se encogen hasta la cabecera mientras
// la app se enfoca detrás.
//
// - Dura 2,5 s y no retrasa nada: la app se prepara por debajo mientras tanto.
// - Se salta con un clic o una tecla. Con «reducir animaciones» de Windows no sale.
// - La escena se dibuja en un escenario de 1280 × 800 que se escala a la ventana. Todo
//   va con un mismo reloj (Web Animations API), así que se puede congelar para probarla.
(() => {
  const TOTAL = 2500;
  const SW = 1280;
  const SH = 800;
  const FOLDER = { x: 500, y: 355, unit: 20 }; // la carpeta grande: el icono de 18 × 18 a 20 px por unidad
  const CENTER = { x: 640, y: 470 };           // centro de la carpeta en el escenario

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const BACK = 'M0 50 H100 L130 0 H280 V230 H0 Z'; // M2 6h5l1.5-2.5H16V15H2z del icono, a escala
  const FRONT = 'M0 0 H280 V120 H0 Z';             // la tapa: de la línea M2 9h14 hacia abajo

  function scene(root) {
    root.innerHTML = `
      <div class="splash-stage">
        <div class="splash-rays"></div>
        <div class="splash-folder">
          <svg class="back" width="280" height="230" viewBox="0 0 280 230" style="left:0;top:0">
            <defs><linearGradient id="splash-g" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#8DBBFA"/><stop offset=".5" stop-color="#7FD4A0"/><stop offset="1" stop-color="#F2B866"/>
            </linearGradient></defs>
            <path class="fill" d="${BACK}" fill="#1B1F26" style="fill-opacity:0"/>
            <path class="grad" d="${BACK}" fill="none" stroke="url(#splash-g)" stroke-width="4" stroke-linejoin="round" pathLength="1" stroke-dasharray="1" style="stroke-dashoffset:1;filter:drop-shadow(0 0 8px rgba(141,187,250,.7))"/>
            <path class="solid" d="${BACK}" fill="none" stroke="#E7E9EC" stroke-width="4" stroke-linejoin="round" style="opacity:0"/>
          </svg>
          <div class="splash-light"></div>
          <svg class="front" width="280" height="120" viewBox="0 0 280 120" style="left:0;top:110px">
            <path class="fill" d="${FRONT}" fill="#232833" style="fill-opacity:0"/>
            <path class="grad" d="${FRONT}" fill="none" stroke="url(#splash-g)" stroke-width="4" stroke-linejoin="round" pathLength="1" stroke-dasharray="1" style="stroke-dashoffset:1;filter:drop-shadow(0 0 8px rgba(127,212,160,.7))"/>
            <path class="solid" d="M0 0 H280" fill="none" stroke="#E7E9EC" stroke-width="4" style="opacity:0"/>
          </svg>
        </div>
        <div class="splash-word">ClaudHome</div>
      </div>`;
    return root.querySelector('.splash-stage');
  }

  // Quita la animación y deja a la vista la cabecera de verdad.
  function remove(root) {
    for (const n of document.querySelectorAll('.splash-landing')) n.classList.remove('splash-landing');
    if (root && root.parentNode) root.remove();
  }

  // Reproduce la animación sobre `root` (una capa que tapa la ventana). `freezeAt`
  // (solo para pruebas) la deja quieta en ese instante. Devuelve una promesa.
  async function play({ root, freezeAt = null }) {
    if (!root) return;
    const brand = document.getElementById('brand-name');
    const logo = document.querySelector('.brand svg');
    const tabs = document.getElementById('tabs');
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !brand || !logo) { remove(root); return; }
    // Lo que va a «aterrizar» se esconde hasta que llegue su copia.
    for (const n of [brand, logo, tabs]) if (n) n.classList.add('splash-landing');

    const W = window.innerWidth;
    const H = window.innerHeight;
    const stage = scene(root);
    const f = Math.min(W / SW, H / SH);
    const ox = (W - SW * f) / 2;
    const oy = (H - SH * f) / 2;
    stage.style.transform = `translate(${ox}px, ${oy}px) scale(${f})`;
    const toStage = (x, y) => ({ x: (x - ox) / f, y: (y - oy) / f });

    // El nombre: centrado encima de la carpeta (la letra tiene que estar cargada para medirlo).
    const wordEl = stage.querySelector('.splash-word');
    await Promise.race([document.fonts.load("600 120px 'IBM Plex Sans'"), new Promise((r) => setTimeout(r, 1000))]).catch(() => {});
    const word = { x: Math.round((SW - wordEl.offsetWidth) / 2), y: 160 };
    wordEl.style.left = `${word.x}px`;
    wordEl.style.top = `${word.y}px`;

    // Adónde aterriza el nombre: encima del de la cabecera, contando su interlineado.
    const b = brand.getBoundingClientRect();
    const bs = getComputedStyle(brand);
    const bSize = parseFloat(bs.fontSize) || 14;
    const bLine = parseFloat(bs.lineHeight) || bSize * 1.2;
    const bt = toStage(b.left, b.top + (bLine - bSize) / 2);
    const wordLanding = `translate(${bt.x - word.x}px, ${bt.y - word.y}px) scale(${bSize / f / 120})`;
    // Y la carpeta, encima del icono (su esquina M2 3.5 cae en la del icono).
    const l = logo.getBoundingClientRect();
    const u = l.width / 18; // píxeles de la ventana por unidad del icono
    const lt = toStage(l.left + 2 * u, l.top + 3.5 * u);
    const folderLanding = `translate(${lt.x - FOLDER.x}px, ${lt.y - FOLDER.y}px) scale(${u / f / FOLDER.unit})`;

    const anims = [];
    const track = (node, steps) => {
      const frames = [];
      if (steps[0][0] > 0) frames.push({ ...steps[0][1], offset: 0 });
      for (const [t, props, easing] of steps) frames.push({ ...props, offset: clamp01(t / TOTAL), easing: easing || 'linear' });
      const last = steps[steps.length - 1];
      if (last[0] < TOTAL) frames.push({ ...last[1], offset: 1 });
      const a = node.animate(frames, { duration: TOTAL, fill: 'both' });
      a.pause();
      anims.push(a);
    };

    const folder = stage.querySelector('.splash-folder');
    const back = folder.querySelector('.back');
    const front = folder.querySelector('.front');
    // Se dibuja con un trazo de luz, se rellena y se abre la tapa.
    track(back.querySelector('.grad'), [[60, { strokeDashoffset: 1 }, 'cubic-bezier(.4,0,.2,1)'], [620, { strokeDashoffset: 0 }]]);
    track(front.querySelector('.grad'), [[260, { strokeDashoffset: 1 }, 'cubic-bezier(.4,0,.2,1)'], [700, { strokeDashoffset: 0 }]]);
    for (const p of folder.querySelectorAll('.fill')) track(p, [[450, { fillOpacity: 0 }], [750, { fillOpacity: 1 }], [1750, { fillOpacity: 1 }], [2150, { fillOpacity: 0 }]]);
    track(front, [[750, { transform: 'perspective(700px) rotateX(0deg)' }, 'cubic-bezier(.3,1.35,.5,1)'], [1080, { transform: 'perspective(700px) rotateX(-68deg)' }],
      [1480, { transform: 'perspective(700px) rotateX(-68deg)' }, 'cubic-bezier(.5,0,.3,1)'], [1760, { transform: 'perspective(700px) rotateX(0deg)' }]]);
    // Luz desde dentro y rayos detrás.
    track(folder.querySelector('.splash-light'), [[720, { opacity: 0, transform: 'scale(0.5)' }, 'cubic-bezier(.2,.8,.2,1)'], [1060, { opacity: 1, transform: 'scale(1)' }],
      [1450, { opacity: 0.85, transform: 'scale(1)' }], [1780, { opacity: 0, transform: 'scale(0.6)' }]]);
    track(stage.querySelector('.splash-rays'), [[850, { opacity: 0, transform: 'rotate(0deg) scale(0.7)' }, 'ease-out'], [1250, { opacity: 1, transform: 'rotate(8deg) scale(1)' }],
      [1700, { opacity: 1, transform: 'rotate(16deg) scale(1.05)' }, 'ease-in'], [2100, { opacity: 0, transform: 'rotate(22deg) scale(1.1)' }]]);
    // El nombre aparece desde un difuminado, lo recorre el arcoíris y vuela a la cabecera.
    track(wordEl, [[1150, { opacity: 0, filter: 'blur(14px)', transform: 'translate(0px, 18px) scale(1)' }, 'cubic-bezier(.2,.8,.2,1)'],
      [1450, { opacity: 1, filter: 'blur(0px)', transform: 'translate(0px, 0px) scale(1)' }],
      [1780, { opacity: 1, filter: 'blur(0px)', transform: 'translate(0px, 0px) scale(1)' }, 'cubic-bezier(.75,0,.2,1)'],
      [2280, { opacity: 1, filter: 'blur(0px)', transform: wordLanding }],
      [2320, { opacity: 0, filter: 'blur(0px)', transform: wordLanding }]]);
    track(wordEl, [[1350, { backgroundPosition: '100% 0' }, 'ease-in-out'], [1850, { backgroundPosition: '0% 0' }]]);
    // La carpeta se cierra y se encoge hasta el icono; el trazo acaba con su mismo grosor y color.
    track(folder, [[1750, { transform: 'translate(0px, 0px) scale(1)', opacity: 1 }, 'cubic-bezier(.75,0,.2,1)'],
      [2280, { transform: folderLanding, opacity: 1 }], [2320, { transform: folderLanding, opacity: 0 }]]);
    for (const p of folder.querySelectorAll('.grad')) {
      track(p, [[1750, { opacity: 1 }], [2200, { opacity: 0 }]]);
      track(p, [[1750, { strokeWidth: 4 }], [2280, { strokeWidth: 30 }]]);
    }
    for (const p of folder.querySelectorAll('.solid')) {
      track(p, [[1750, { opacity: 0 }], [2200, { opacity: 1 }]]);
      track(p, [[1750, { strokeWidth: 4 }], [2280, { strokeWidth: 30 }]]);
    }
    // El fondo se aclara y se desenfoca menos: la app aparece enfocándose detrás.
    track(root, [[1750, { backgroundColor: 'rgba(12, 14, 17, 1)', backdropFilter: 'blur(8px)' }, 'cubic-bezier(.2,.7,.2,1)'],
      [2300, { backgroundColor: 'rgba(12, 14, 17, 0)', backdropFilter: 'blur(0px)' }]]);

    // Tus pestañas salen de la carpeta hasta su sitio. Se copian justo antes de salir,
    // cuando la app ya las ha pintado (como mucho 8; si no hay ninguna, no sale nada).
    let flown = false;
    const flyTabs = () => {
      flown = true;
      const real = tabs ? [...tabs.querySelectorAll('.tab')].filter((n) => {
        const r = n.getBoundingClientRect();
        return r.width > 0 && r.right > 0 && r.left < W;
      }).slice(0, 8) : [];
      const fc = { x: ox + CENTER.x * f, y: oy + CENTER.y * f };
      const gap = Math.min(130, 520 / Math.max(1, real.length));
      real.forEach((tab, j) => {
        const r = tab.getBoundingClientRect();
        const c = tab.cloneNode(true);
        c.removeAttribute('data-id');
        c.classList.add('splash-tab');
        Object.assign(c.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        root.append(c);
        const dx = fc.x - (r.left + r.width / 2);
        const dy = fc.y - (r.top + r.height / 2);
        const rot = (j % 2 ? 1 : -1) * (8 + ((j * 7) % 9));
        const t0 = 1000 + j * gap;
        track(c, [[t0, { transform: `translate(${dx}px, ${dy}px) scale(0.25) rotate(${rot}deg)` }, 'cubic-bezier(.2,.6,.3,1)'],
          [t0 + 300, { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - 150 * f}px) scale(0.85) rotate(${rot / 2}deg)` }, 'cubic-bezier(.5,0,.3,1)'],
          [t0 + 600, { transform: 'translate(0px, 0px) scale(1.06) rotate(0deg)' }, 'ease-out'],
          [t0 + 720, { transform: 'translate(0px, 0px) scale(1) rotate(0deg)' }]]);
        track(c, [[t0, { opacity: 0 }], [t0 + 60, { opacity: 1 }], [2300, { opacity: 1 }, 'steps(1, end)'], [2310, { opacity: 0 }]]);
      });
    };

    const render = (t) => {
      if (!flown && t >= 900) flyTabs();
      for (const a of anims) a.currentTime = Math.min(t, TOTAL - 0.01);
      if (t >= 2300) for (const n of [brand, logo, tabs]) if (n) n.classList.remove('splash-landing');
    };

    if (freezeAt !== null) {
      // Pruebas: se espera a que la app pinte las pestañas y se queda quieta en ese instante.
      setTimeout(() => render(freezeAt), 1500);
      return;
    }

    await new Promise((resolve) => {
      const start = performance.now();
      let raf = 0;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        cancelAnimationFrame(raf);
        window.removeEventListener('pointerdown', skip, true);
        window.removeEventListener('keydown', skip, true);
        resolve();
      };
      // Un clic o una tecla la terminan con un fundido rápido.
      function skip() {
        if (done) return;
        cancelAnimationFrame(raf);
        for (const n of [brand, logo, tabs]) if (n) n.classList.remove('splash-landing');
        root.style.pointerEvents = 'none';
        root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).finished.then(finish, finish);
      }
      window.addEventListener('pointerdown', skip, true);
      window.addEventListener('keydown', skip, true);
      const loop = (now) => {
        const t = now - start;
        render(Math.min(t, TOTAL));
        if (t >= TOTAL) finish();
        else raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    });
    remove(root);
  }

  window.ClaudHomeSplash = { play, remove, TOTAL };
})();
