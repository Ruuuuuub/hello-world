'use strict';
/* =========================================================================
   État des lieux vidéo horodaté
   - Visite guidée pièce par pièce, enregistrement vidéo avec incrustation
     de la date/heure et de la pièce directement dans l'image.
   - Signalement de défauts : photo extraite du flux, horodatage, position
     dans la vidéo.
   - Empreinte SHA-256 de chaque vidéo et du rapport final.
   - Comparaison entrée / sortie pour objectiver la restitution de la caution.
   Tout est stocké localement (IndexedDB), rien n'est envoyé sur un serveur.
   ========================================================================= */

// ---------- Utilitaires ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const go = path => { location.hash = '#' + path; };
const fmtDT = iso => iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' }) : '—';
const fmtDate = iso => iso ? new Date(iso).toLocaleDateString('fr-FR', { dateStyle: 'long' }) : '—';
const fmtDur = sec => { if (sec == null || !isFinite(sec)) return '—'; sec = Math.max(0, Math.round(sec)); return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`; };
const fmtSize = b => b > 1e6 ? (b / 1e6).toFixed(1) + ' Mo' : Math.round(b / 1e3) + ' ko';
const typeLabel = t => t === 'sortie' ? 'Sortie' : 'Entrée';
const slug = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}
async function sha256(data) {
  if (!crypto.subtle) return 'indisponible (contexte non sécurisé)';
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- Référentiels ----------
const STATES = [
  ['', 'Non renseigné'], ['neuf', 'Neuf'], ['bon', 'Bon état'],
  ['usage', "État d'usage"], ['mauvais', 'Mauvais état'], ['hs', 'Hors service'],
];
const STATE_RANK = { neuf: 5, bon: 4, usage: 3, mauvais: 2, hs: 1 };
const stateLabel = k => (STATES.find(s => s[0] === k) || STATES[0])[1];
const stateBadge = k => {
  if (!k) return `<span class="badge">${stateLabel(k)}</span>`;
  const cls = STATE_RANK[k] >= 4 ? 'ok' : STATE_RANK[k] === 3 ? 'warn' : 'danger';
  return `<span class="badge ${cls}">${stateLabel(k)}</span>`;
};
const SEVERITIES = [['mineur', 'Mineur'], ['moyen', 'Moyen'], ['important', 'Important']];
const sevBadge = k => `<span class="badge ${k === 'important' ? 'danger' : k === 'moyen' ? 'warn' : ''}">${(SEVERITIES.find(s => s[0] === k) || SEVERITIES[0])[1]}</span>`;

const BASE = ['Murs', 'Sol', 'Plafond', 'Porte(s)', 'Fenêtre(s) & volets', 'Prises & interrupteurs', 'Éclairage', 'Chauffage / radiateur'];
const TEMPLATES = {
  entree: { name: 'Entrée', elements: ['Porte d\'entrée & serrure', 'Interphone / sonnette', ...BASE.filter(e => e !== 'Fenêtre(s) & volets'), 'Placard'] },
  sejour: { name: 'Séjour', elements: [...BASE] },
  cuisine: { name: 'Cuisine', elements: [...BASE, 'Évier & robinetterie', 'Plan de travail', 'Meubles & placards', 'Plaques de cuisson / four', 'Hotte', 'Réfrigérateur'] },
  chambre: { name: 'Chambre', elements: [...BASE, 'Placard / penderie'] },
  sdb: { name: 'Salle de bain', elements: ['Murs & faïence', 'Sol', 'Plafond', 'Porte', 'Lavabo & robinetterie', 'Douche / baignoire', 'Joints silicone', 'Miroir & meuble', 'Ventilation (VMC)', 'Éclairage', 'Prises & interrupteurs', 'Radiateur / sèche-serviettes'] },
  wc: { name: 'WC', elements: ['Murs', 'Sol', 'Plafond', 'Porte', 'Cuvette & abattant', 'Chasse d\'eau', 'Lave-mains', 'Ventilation', 'Éclairage'] },
  couloir: { name: 'Couloir / dégagement', elements: ['Murs', 'Sol', 'Plafond', 'Porte(s)', 'Éclairage', 'Prises & interrupteurs', 'Placard'] },
  exterieur: { name: 'Balcon / terrasse', elements: ['Sol', 'Garde-corps', 'Revêtement mural', 'Éclairage extérieur', 'Évacuation des eaux'] },
  annexe: { name: 'Cave / parking', elements: ['Porte & serrure', 'Murs', 'Sol', 'Éclairage'] },
  autre: { name: 'Autre pièce', elements: [...BASE] },
};
const DEFAULT_ROOMS = ['entree', 'sejour', 'cuisine', 'chambre', 'sdb', 'wc'];
const METERS = [
  ['elec', 'Électricité (index kWh)'], ['gaz', 'Gaz (index m³)'],
  ['eauFroide', 'Eau froide (index m³)'], ['eauChaude', 'Eau chaude (index m³)'],
  ['cles', 'Clés remises (nombre & type)'], ['badges', 'Badges / télécommandes'],
];
const TIPS = [
  'Placez-vous sur le seuil et faites un panoramique lent à 360°.',
  'Suivez les éléments affichés et appuyez sur « Élément suivant » à chaque étape : un chapitre est marqué dans la vidéo.',
  'Approchez-vous de chaque défaut puis appuyez sur « Signaler un défaut » : une photo horodatée est extraite.',
  'Testez les équipements à l\'image (lumières, robinets, volets, chasse d\'eau).',
  'Commentez à voix haute ce que vous constatez.',
];

function makeRoom(tpl, name) {
  const t = TEMPLATES[tpl] || TEMPLATES.autre;
  return { id: uid(), tpl, name: name || t.name, elements: t.elements.map(n => ({ name: n, state: '', comment: '' })), videos: [], defects: [], done: false };
}

// ---------- Stockage local (IndexedDB) ----------
const DB = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('edl-video', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('inspections', { keyPath: 'id' });
        db.createObjectStore('videos', { keyPath: 'id' }).createIndex('inspectionId', 'inspectionId');
      };
      r.onsuccess = () => res(this._db = r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async req(store, mode, op) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, mode);
      const r = op(tx.objectStore(store));
      let out;
      r.onsuccess = () => { out = r.result; };
      tx.oncomplete = () => res(out);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error || new Error('Transaction annulée (espace de stockage insuffisant ?)'));
    });
  },
  all: s => DB.req(s, 'readonly', st => st.getAll()),
  get: (s, id) => DB.req(s, 'readonly', st => st.get(id)),
  put: (s, v) => DB.req(s, 'readwrite', st => st.put(v)),
  del: (s, id) => DB.req(s, 'readwrite', st => st.delete(id)),
  videosFor: id => DB.req('videos', 'readonly', st => st.index('inspectionId').getAll(id)),
};
const saveInsp = insp => { insp.updatedAt = new Date().toISOString(); return DB.put('inspections', insp); };

// ---------- Caméra & enregistrement horodaté ----------
const Cam = {
  stream: null, video: null, canvas: null, ctx: null, raf: 0, rec: null, chunks: [],
  recId: null, recStart: 0, startedAt: null, label: '', prompt: '', markers: [],
  get active() { return !!this.stream; },
  get recording() { return !!this.rec; },
  get t() { return this.rec ? (performance.now() - this.recStart) / 1000 : null; },

  async start(canvas, label) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Caméra non disponible sur ce navigateur.');
    const video = { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } };
    try { this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: true }); }
    catch (e) { this.stream = await navigator.mediaDevices.getUserMedia({ video }); }
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.label = label;
    this.video = document.createElement('video');
    this.video.className = 'hiddenvid'; this.video.muted = true; this.video.playsInline = true;
    this.video.setAttribute('playsinline', ''); this.video.srcObject = this.stream;
    canvas.parentElement.appendChild(this.video);
    await this.video.play();
    const loop = () => { this.draw(); this.raf = requestAnimationFrame(loop); };
    loop();
  },

  draw() {
    const v = this.video, c = this.canvas, ctx = this.ctx;
    if (!v || !v.videoWidth) return;
    if (c.width !== v.videoWidth) { c.width = v.videoWidth; c.height = v.videoHeight; }
    const w = c.width, h = c.height;
    ctx.drawImage(v, 0, 0, w, h);
    // Incrustation horodatée (fait partie de l'image enregistrée)
    const bar = Math.round(h * 0.075), fs = Math.round(bar * 0.48);
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(0, h - bar, w, bar);
    ctx.font = `600 ${fs}px system-ui, sans-serif`; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
    ctx.fillText(`${this.label} · ${new Date().toLocaleString('fr-FR')}`, fs * 0.6, h - bar / 2);
    if (this.rec) {
      ctx.textAlign = 'right';
      ctx.fillStyle = '#ff4d47'; ctx.beginPath(); ctx.arc(w - fs * 4.6, h - bar / 2, fs * 0.3, 0, 7); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText(`REC ${fmtDur(this.t)}`, w - fs * 0.6, h - bar / 2);
      if (this.prompt) {
        ctx.textAlign = 'left';
        const pw = ctx.measureText(this.prompt).width + fs * 1.2;
        ctx.fillStyle = 'rgba(31,94,255,.85)'; ctx.fillRect(fs * 0.5, fs * 0.5, pw, fs * 1.6);
        ctx.fillStyle = '#fff'; ctx.fillText(this.prompt, fs * 1.1, fs * 1.3);
      }
    }
  },

  record() {
    const cs = this.canvas.captureStream(30);
    this.stream.getAudioTracks().forEach(t => cs.addTrack(t));
    const mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find(m => window.MediaRecorder?.isTypeSupported?.(m)) || '';
    if (!window.MediaRecorder) throw new Error('Enregistrement vidéo non pris en charge par ce navigateur.');
    this.rec = new MediaRecorder(cs, mime ? { mimeType: mime, videoBitsPerSecond: 2500000 } : {});
    this.chunks = [];
    this.rec.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.recId = uid(); this.startedAt = new Date(); this.recStart = performance.now(); this.markers = [];
    this.rec.start(1000);
  },

  stopRecording() {
    return new Promise(res => {
      const rec = this.rec;
      rec.onstop = () => {
        const type = (rec.mimeType || 'video/webm').split(';')[0];
        const blob = new Blob(this.chunks, { type });
        res({ id: this.recId, blob, mime: type, startedAt: this.startedAt.toISOString(), endedAt: new Date().toISOString(), duration: (performance.now() - this.recStart) / 1000, markers: this.markers });
        this.rec = null; this.chunks = [];
      };
      rec.stop();
    });
  },

  mark(label) { if (this.rec) this.markers.push({ t: this.t, label, at: new Date().toISOString() }); },

  snapshot(maxW = 960) {
    const c = document.createElement('canvas'), s = Math.min(1, maxW / this.canvas.width);
    c.width = Math.round(this.canvas.width * s); c.height = Math.round(this.canvas.height * s);
    c.getContext('2d').drawImage(this.canvas, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.78);
  },

  stop() {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach(t => t.stop());
    this.video?.remove();
    this.stream = this.video = this.rec = null; this.prompt = '';
  },
};

// Contexte d'enregistrement en cours : permet de sauver la vidéo si l'on quitte la page.
let recCtx = null;
let objectUrls = [];
async function cleanup() {
  if (Cam.recording && recCtx) {
    const r = await Cam.stopRecording();
    await persistVideo(recCtx.insp, recCtx.room, r, 'camera');
    toast('Enregistrement sauvegardé.');
  }
  recCtx = null;
  Cam.stop();
  objectUrls.forEach(u => URL.revokeObjectURL(u)); objectUrls = [];
}
window.addEventListener('beforeunload', e => { if (Cam.recording) { e.preventDefault(); e.returnValue = ''; } });

async function persistVideo(insp, room, r, source) {
  const hash = await sha256(await r.blob.arrayBuffer());
  const meta = { id: r.id || uid(), startedAt: r.startedAt, endedAt: r.endedAt, duration: r.duration, mime: r.mime, size: r.blob.size, sha256: hash, markers: r.markers || [], source, fileName: r.fileName || null };
  await DB.put('videos', { ...meta, inspectionId: insp.id, roomId: room.id, blob: r.blob });
  room.videos.push(meta);
  await saveInsp(insp);
  return meta;
}

// Horodate une image importée (pas de caméra en direct)
function stampImage(file, text, maxW = 960) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, maxW / img.width), c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, c.width, c.height);
      const bar = Math.round(c.height * 0.08), fs = Math.round(bar * 0.45);
      ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(0, c.height - bar, c.width, bar);
      ctx.fillStyle = '#fff'; ctx.font = `600 ${fs}px system-ui, sans-serif`; ctx.textBaseline = 'middle';
      ctx.fillText(text, fs * 0.6, c.height - bar / 2);
      URL.revokeObjectURL(img.src); res(c.toDataURL('image/jpeg', 0.78));
    };
    img.onerror = rej; img.src = URL.createObjectURL(file);
  });
}

// ---------- Rendu ----------
function render(html, crumb = '') {
  $('#app').innerHTML = html;
  $('#crumb').textContent = crumb;
  window.scrollTo(0, 0);
}

let routing = Promise.resolve();
window.addEventListener('hashchange', () => { routing = routing.then(route); });
async function route() {
  await cleanup();
  const parts = (location.hash.slice(1) || '/').split('/').filter(Boolean);
  try {
    if (!parts.length) return await viewHome();
    if (parts[0] === 'new') return await viewNew();
    if (parts[0] === 'i' && parts[1]) {
      const insp = await DB.get('inspections', parts[1]);
      if (!insp) return go('/');
      if (!parts[2]) return await viewOverview(insp);
      if (parts[2] === 'r') return await viewRoom(insp, parts[3]);
      if (parts[2] === 'sign') return await viewSign(insp);
      if (parts[2] === 'report') return await viewReport(insp);
    }
    go('/');
  } catch (e) {
    console.error(e);
    render(`<div class="card"><h2>Une erreur est survenue</h2><p class="muted">${esc(e.message)}</p><a class="btn" href="#/">Retour à l'accueil</a></div>`);
  }
}

// ---------- Accueil ----------
async function viewHome() {
  const list = (await DB.all('inspections')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const item = i => {
    const done = i.rooms.filter(r => r.done).length;
    return `<li>
      <a class="item" href="#/i/${i.id}">
        <span class="dot ${i.finalizedAt ? 'done' : ''}">${i.finalizedAt ? '✓' : i.type === 'sortie' ? 'S' : 'E'}</span>
        <span class="grow">
          <b>${esc(i.address || 'Logement sans adresse')}</b><br>
          <span class="small muted">${typeLabel(i.type)} · ${fmtDT(i.createdAt)} · ${done}/${i.rooms.length} pièces</span>
        </span>
        ${i.finalizedAt ? '<span class="badge ok">Signé</span>' : '<span class="badge warn">En cours</span>'}
      </a>
      <button class="btn sm danger" data-del="${i.id}" aria-label="Supprimer">✕</button>
    </li>`;
  };
  render(`
    <h1>États des lieux vidéo</h1>
    <div class="card">
      <p style="margin-top:0">Filmez le logement pièce par pièce. Chaque image porte la date et l'heure, les défauts sont repérés et un rapport daté et signé est produit. <b>Fini les litiges sur la caution.</b></p>
      <a class="btn primary block" href="#/new">＋ Nouvel état des lieux</a>
    </div>
    <div class="card">
      <h2>Mes états des lieux</h2>
      ${list.length ? `<ul class="list">${list.map(item).join('')}</ul>` : '<p class="muted">Aucun état des lieux pour l\'instant.</p>'}
    </div>
    <p class="small muted">🔒 Les vidéos et données restent sur cet appareil (aucun envoi sur un serveur). Pensez à exporter le rapport et les vidéos.</p>
  `, '');
  $$('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Supprimer définitivement cet état des lieux et ses vidéos ?')) return;
    const id = b.dataset.del;
    for (const v of await DB.videosFor(id)) await DB.del('videos', v.id);
    await DB.del('inspections', id);
    viewHome();
  });
}

// ---------- Nouvel état des lieux ----------
async function viewNew() {
  const entrees = (await DB.all('inspections')).filter(i => i.type === 'entree').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  render(`
    <h1>Nouvel état des lieux</h1>
    <form id="f" class="card stack">
      <div class="seg">
        <label><input type="radio" name="type" value="entree" checked><span>🔑 Entrée</span></label>
        <label><input type="radio" name="type" value="sortie"><span>📦 Sortie</span></label>
      </div>
      <div id="linkBox" hidden>
        <label class="field">Comparer avec l'état des lieux d'entrée
          <select name="linkedId">
            <option value="">— Aucun (sortie indépendante) —</option>
            ${entrees.map(e => `<option value="${e.id}">${esc(e.address || 'Sans adresse')} — ${fmtDate(e.createdAt)}</option>`).join('')}
          </select>
        </label>
        <p class="small muted">Les pièces et éléments de l'entrée sont repris, et le rapport de sortie fait ressortir automatiquement les dégradations.</p>
      </div>
      <label class="field">Adresse du logement<input type="text" name="address" required placeholder="12 rue des Lilas, 75011 Paris, 3e étage gauche"></label>
      <div class="grid2">
        <label class="field">Bailleur / agence<input type="text" name="landlord" placeholder="Nom"></label>
        <label class="field">Locataire(s)<input type="text" name="tenant" placeholder="Nom(s)"></label>
      </div>
      <label class="field">Type de location
        <select name="furnished"><option value="vide">Location vide</option><option value="meuble">Location meublée</option></select>
      </label>
      <div id="roomsBox">
        <h3>Pièces à visiter</h3>
        <div class="chips">
          ${Object.entries(TEMPLATES).map(([k, t]) => `<label class="chip"><input type="checkbox" name="room" value="${k}" ${DEFAULT_ROOMS.includes(k) ? 'checked' : ''}> ${t.name}</label>`).join('')}
        </div>
        <p class="small muted">Vous pourrez ajouter d'autres pièces (Chambre 2…) ensuite.</p>
      </div>
      <button class="btn primary block">Créer et commencer</button>
    </form>`, 'Nouveau');

  const f = $('#f');
  const sync = () => {
    const sortie = f.type.value === 'sortie';
    $('#linkBox').hidden = !sortie || !entrees.length;
    $('#roomsBox').hidden = sortie && !!f.linkedId.value;
  };
  f.addEventListener('change', e => {
    if (e.target.name === 'linkedId' && e.target.value) {
      const e0 = entrees.find(x => x.id === e.target.value);
      f.address.value = e0.address; f.landlord.value = e0.landlord; f.tenant.value = e0.tenant; f.furnished.value = e0.furnished || 'vide';
    }
    sync();
  });
  sync();

  f.onsubmit = async ev => {
    ev.preventDefault();
    const type = f.type.value, linkedId = type === 'sortie' ? f.linkedId.value : '';
    let rooms;
    if (linkedId) {
      const e0 = entrees.find(x => x.id === linkedId);
      rooms = e0.rooms.map(r => ({ id: r.id, tpl: r.tpl, name: r.name, elements: r.elements.map(e => ({ name: e.name, state: '', comment: '' })), videos: [], defects: [], done: false }));
    } else {
      rooms = $$('input[name=room]:checked', f).map(c => makeRoom(c.value));
    }
    if (!rooms.length) return toast('Sélectionnez au moins une pièce.');
    const insp = {
      id: uid(), type, linkedId: linkedId || null, address: f.address.value.trim(), landlord: f.landlord.value.trim(),
      tenant: f.tenant.value.trim(), furnished: f.furnished.value, createdAt: new Date().toISOString(),
      rooms, meters: {}, signatures: null, finalizedAt: null,
    };
    await saveInsp(insp);
    navigator.storage?.persist?.();
    go('/i/' + insp.id);
  };
}

// ---------- Vue d'ensemble ----------
async function viewOverview(insp) {
  const locked = !!insp.finalizedAt;
  const done = insp.rooms.filter(r => r.done).length;
  const next = insp.rooms.find(r => !r.done) || insp.rooms[0];
  const linked = insp.linkedId ? await DB.get('inspections', insp.linkedId) : null;
  render(`
    <h1>${esc(insp.address || 'Logement')}</h1>
    <div class="card">
      <div class="row between">
        <span class="badge">${typeLabel(insp.type)}</span>
        ${locked ? `<span class="badge ok">Finalisé le ${fmtDT(insp.finalizedAt)}</span>` : '<span class="badge warn">En cours</span>'}
      </div>
      <p class="small muted">Commencé le ${fmtDT(insp.createdAt)} · Bailleur : ${esc(insp.landlord || '—')} · Locataire : ${esc(insp.tenant || '—')}
      ${linked ? `<br>Comparé à l'entrée du ${fmtDate(linked.createdAt)}` : ''}</p>
      <div class="progress" aria-label="Progression"><i style="width:${insp.rooms.length ? done / insp.rooms.length * 100 : 0}%"></i></div>
      <p class="small muted">${done} / ${insp.rooms.length} pièces terminées</p>
      ${locked ? `<a class="btn primary block" href="#/i/${insp.id}/report">📄 Voir le rapport</a>`
               : `<a class="btn primary block" href="#/i/${insp.id}/r/${next?.id}">🎥 ${done ? 'Reprendre' : 'Démarrer'} la visite guidée</a>`}
    </div>

    <div class="card">
      <h2>Pièces</h2>
      <ul class="list">
        ${insp.rooms.map((r, i) => `<li>
          <a class="item" href="#/i/${insp.id}/r/${r.id}">
            <span class="dot ${r.done ? 'done' : ''}">${r.done ? '✓' : i + 1}</span>
            <span class="grow"><b>${esc(r.name)}</b><br><span class="small muted">${r.videos.length} vidéo(s) · ${r.defects.length} défaut(s) · ${r.elements.filter(e => e.state).length}/${r.elements.length} éléments</span></span>
          </a>
          ${!locked && !r.videos.length ? `<button class="btn sm danger" data-delroom="${r.id}" aria-label="Retirer la pièce">✕</button>` : ''}
        </li>`).join('')}
      </ul>
      ${locked ? '' : `<form id="addRoom" class="row" style="margin-top:10px">
        <select name="tpl" style="flex:1;min-width:140px">${Object.entries(TEMPLATES).map(([k, t]) => `<option value="${k}">${t.name}</option>`).join('')}</select>
        <input type="text" name="name" placeholder="Nom (ex. Chambre 2)" style="flex:1;min-width:140px">
        <button class="btn">＋ Ajouter</button>
      </form>`}
    </div>

    <div class="card">
      <h2>Compteurs & clés</h2>
      <div class="grid2" id="meters">
        ${METERS.map(([k, l]) => `<label class="field">${l}<input type="text" data-meter="${k}" value="${esc(insp.meters?.[k])}" ${locked ? 'disabled' : ''}></label>`).join('')}
      </div>
      <p class="small muted">Astuce : filmez aussi les compteurs pendant la visite de la pièce où ils se trouvent.</p>
    </div>

    <div class="row">
      ${locked ? '' : `<a class="btn grow" href="#/i/${insp.id}/sign">✍️ Signatures & finalisation</a>`}
      <a class="btn grow" href="#/i/${insp.id}/report">📄 ${locked ? 'Rapport' : 'Aperçu du rapport'}</a>
    </div>
  `, typeLabel(insp.type));

  if (locked) return;
  $('#addRoom').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    insp.rooms.push(makeRoom(fd.get('tpl'), fd.get('name').trim() || undefined));
    await saveInsp(insp); viewOverview(insp);
  };
  $$('[data-delroom]').forEach(b => b.onclick = async () => {
    if (!confirm('Retirer cette pièce ?')) return;
    insp.rooms = insp.rooms.filter(r => r.id !== b.dataset.delroom);
    await saveInsp(insp); viewOverview(insp);
  });
  $$('[data-meter]').forEach(inp => inp.onchange = () => { insp.meters = insp.meters || {}; insp.meters[inp.dataset.meter] = inp.value.trim(); saveInsp(insp); });
}

// ---------- Visite d'une pièce ----------
async function viewRoom(insp, roomId) {
  const idx = insp.rooms.findIndex(r => r.id === roomId);
  if (idx < 0) return go('/i/' + insp.id);
  const room = insp.rooms[idx], locked = !!insp.finalizedAt;
  const linked = insp.linkedId ? await DB.get('inspections', insp.linkedId) : null;
  const refRoom = linked?.rooms.find(r => r.id === room.id);
  const refEl = name => refRoom?.elements.find(e => e.name === name);
  const label = `ÉDL ${typeLabel(insp.type)} · ${room.name}`;
  const prev = insp.rooms[idx - 1], next = insp.rooms[idx + 1];
  let step = 0;

  render(`
    <div class="row between"><h1 style="margin-bottom:.5rem">${esc(room.name)}</h1><span class="badge">Pièce ${idx + 1}/${insp.rooms.length}</span></div>

    ${locked ? '<div class="card flat"><b>État des lieux finalisé :</b> consultation uniquement.</div>' : `
    <details class="card flat" ${room.videos.length ? '' : 'open'}>
      <summary><b>Comment filmer cette pièce</b></summary>
      <ol class="small" style="margin:.6rem 0 0;padding-left:1.2rem">${TIPS.map(t => `<li>${t}</li>`).join('')}</ol>
    </details>

    <div class="card">
      <div class="cam">
        <canvas id="cv" width="1280" height="720"></canvas>
        <div class="off" id="camOff">
          <div><p>La vidéo sera horodatée automatiquement<br><span class="small">(date, heure et pièce incrustées dans l'image)</span></p>
          <button class="btn primary" id="camOn">📷 Activer la caméra</button></div>
        </div>
      </div>
      <div class="prompt" id="prompt">
        <span class="grow">À filmer : <b id="promptName"></b> <span class="small muted" id="promptPos"></span></span>
        <button class="btn sm" id="stepPrev" aria-label="Élément précédent">←</button>
        <button class="btn sm primary" id="stepNext">Élément suivant →</button>
      </div>
      <div class="recbar">
        <button class="btn rec" id="recBtn" disabled>● Enregistrer</button>
        <button class="btn warn" id="defBtn">⚠ Signaler un défaut</button>
      </div>
      <div class="row" style="margin-top:10px">
        <label class="btn sm">⬆ Importer une vidéo<input type="file" accept="video/*" id="impVid" hidden></label>
        <span class="small muted grow">Si la caméra intégrée ne fonctionne pas, filmez avec l'appareil photo puis importez.</span>
      </div>
    </div>`}

    <div class="card videos"><h2>Vidéos</h2><div id="vids"></div></div>

    <div class="card">
      <h2>Défauts repérés</h2>
      <div id="defs"></div>
      ${locked ? '' : '<button class="btn sm" id="defManual" style="margin-top:8px">＋ Ajouter un défaut avec photo</button>'}
    </div>

    <div class="card">
      <h2>État des éléments</h2>
      ${refRoom ? `<p class="small muted">Entre parenthèses : état constaté à l'entrée du ${fmtDate(linked.createdAt)}.</p>` : ''}
      <div id="els">
        ${room.elements.map((e, i) => `<div class="el" data-i="${i}">
          <div class="name">${esc(e.name)} ${refEl(e.name) ? `<span class="ref">(entrée : ${stateLabel(refEl(e.name).state)})</span>` : ''}</div>
          <select data-state ${locked ? 'disabled' : ''}>${STATES.map(([k, l]) => `<option value="${k}" ${e.state === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <input class="cmt" type="text" data-cmt placeholder="Commentaire (couleur, matériau, observation…)" value="${esc(e.comment)}" ${locked ? 'disabled' : ''}>
        </div>`).join('')}
      </div>
      ${locked ? '' : `<button class="btn sm" id="allGood" style="margin-top:8px">Mettre les éléments non renseignés en « Bon état »</button>`}
    </div>

    <div class="footer-nav"><div class="inner">
      <a class="btn" href="#/i/${insp.id}${prev ? '/r/' + prev.id : ''}">← ${prev ? 'Précédente' : 'Sommaire'}</a>
      ${locked ? `<a class="btn primary" href="#/i/${insp.id}${next ? '/r/' + next.id : '/report'}">${next ? 'Suivante →' : 'Rapport →'}</a>`
               : `<button class="btn primary" id="doneBtn">${next ? 'Pièce terminée →' : 'Terminer la visite ✓'}</button>`}
    </div></div>
  `, `${typeLabel(insp.type)} · ${room.name}`);

  // --- Éléments
  const markWorse = () => $$('.el').forEach(div => {
    const e = room.elements[div.dataset.i], r = refEl(e.name);
    div.classList.toggle('worse', !!(r && r.state && e.state && STATE_RANK[e.state] < STATE_RANK[r.state]));
  });
  markWorse();
  $$('.el').forEach(div => {
    const e = room.elements[div.dataset.i];
    $('[data-state]', div).onchange = ev => { e.state = ev.target.value; markWorse(); saveInsp(insp); };
    $('[data-cmt]', div).onchange = ev => { e.comment = ev.target.value.trim(); saveInsp(insp); };
  });
  $('#allGood') && ($('#allGood').onclick = () => {
    room.elements.forEach(e => { if (!e.state) e.state = 'bon'; });
    $$('.el').forEach(div => { $('[data-state]', div).value = room.elements[div.dataset.i].state; });
    markWorse(); saveInsp(insp); toast('Éléments mis à jour.');
  });

  // --- Vidéos
  async function renderVideos() {
    const box = $('#vids');
    if (!room.videos.length) { box.innerHTML = '<p class="muted small">Aucune vidéo pour cette pièce.</p>'; return; }
    box.innerHTML = room.videos.map(v => `<div class="stack" style="margin-bottom:14px" data-v="${v.id}">
      <video controls playsinline preload="metadata"></video>
      <div class="row between small">
        <span>🕒 ${fmtDT(v.startedAt)} · ${fmtDur(v.duration)} · ${fmtSize(v.size)}${v.source === 'import' ? ' · <span class="badge warn">importée</span>' : ''}</span>
        <span class="row">
          <a class="btn sm" data-dl download>⬇ Télécharger</a>
          ${locked ? '' : '<button class="btn sm danger" data-rm>Supprimer</button>'}
        </span>
      </div>
      ${v.markers?.length ? `<div class="chips small">${v.markers.map(m => `<button class="chip" data-seek="${m.t}">${fmtDur(m.t)} ${esc(m.label)}</button>`).join('')}</div>` : ''}
      <div class="mono muted">SHA-256 : ${v.sha256}</div>
    </div>`).join('');
    for (const v of room.videos) {
      const rec = await DB.get('videos', v.id), wrap = $(`[data-v="${v.id}"]`, box);
      if (!rec || !wrap) continue;
      const url = URL.createObjectURL(rec.blob); objectUrls.push(url);
      const vid = $('video', wrap); vid.src = url;
      const a = $('[data-dl]', wrap); a.href = url; a.download = videoFileName(insp, room, v);
      $$('[data-seek]', wrap).forEach(b => b.onclick = () => { vid.currentTime = +b.dataset.seek; vid.play(); });
      const rm = $('[data-rm]', wrap);
      if (rm) rm.onclick = async () => {
        if (!confirm('Supprimer cette vidéo ? Les défauts associés sont conservés.')) return;
        await DB.del('videos', v.id);
        room.videos = room.videos.filter(x => x.id !== v.id);
        await saveInsp(insp); renderVideos();
      };
    }
  }

  // --- Défauts
  function renderDefects() {
    const box = $('#defs');
    if (!room.defects.length) { box.innerHTML = '<p class="muted small">Aucun défaut signalé.</p>'; return; }
    box.innerHTML = room.defects.map(d => `<div class="defect">
      ${d.photo ? `<img src="${d.photo}" alt="Photo du défaut">` : ''}
      <div class="grow small">
        <div class="row"><b>${esc(d.element)}</b> ${sevBadge(d.severity)}</div>
        <div>${esc(d.description) || '<span class="muted">Sans description</span>'}</div>
        <div class="muted">🕒 ${fmtDT(d.at)}${d.videoTime != null ? ` · à ${fmtDur(d.videoTime)} dans la vidéo` : ''}</div>
      </div>
      ${locked ? '' : `<button class="btn sm danger" data-rmdef="${d.id}" aria-label="Supprimer">✕</button>`}
    </div>`).join('');
    $$('[data-rmdef]', box).forEach(b => b.onclick = async () => {
      if (!confirm('Supprimer ce défaut ?')) return;
      room.defects = room.defects.filter(d => d.id !== b.dataset.rmdef);
      await saveInsp(insp); renderDefects();
    });
  }

  renderVideos(); renderDefects();

  // --- Navigation
  const doneBtn = $('#doneBtn');
  if (doneBtn) doneBtn.onclick = async () => {
    if (Cam.recording) await stopRec();
    const missing = room.elements.filter(e => !e.state).length;
    if (!room.videos.length && !confirm('Aucune vidéo pour cette pièce. Continuer quand même ?')) return;
    if (missing && !confirm(`${missing} élément(s) sans état renseigné. Continuer quand même ?`)) return;
    room.done = true; await saveInsp(insp);
    const nextTodo = insp.rooms.slice(idx + 1).find(r => !r.done) || insp.rooms.find(r => !r.done);
    go(nextTodo ? `/i/${insp.id}/r/${nextTodo.id}` : `/i/${insp.id}/sign`);
  };

  if (locked) return;

  // --- Guidage élément par élément
  const updatePrompt = () => {
    const e = room.elements[step];
    $('#promptName').textContent = e ? e.name : '—';
    $('#promptPos').textContent = `(${step + 1}/${room.elements.length})`;
    $('#stepPrev').disabled = step === 0;
    $('#stepNext').disabled = step >= room.elements.length - 1;
    Cam.prompt = e ? `▶ ${e.name}` : '';
  };
  $('#stepNext').onclick = () => { if (step < room.elements.length - 1) { step++; updatePrompt(); Cam.mark(room.elements[step].name); } };
  $('#stepPrev').onclick = () => { if (step > 0) { step--; updatePrompt(); Cam.mark(room.elements[step].name); } };

  // --- Caméra
  const recBtn = $('#recBtn');
  $('#camOn').onclick = async () => {
    try {
      await Cam.start($('#cv'), label);
      $('#camOff').hidden = true; recBtn.disabled = false; updatePrompt();
    } catch (e) {
      toast('Caméra inaccessible : ' + (e.message || e.name));
    }
  };
  async function stopRec() {
    recBtn.disabled = true;
    const r = await Cam.stopRecording();
    const ctx = recCtx; recCtx = null;
    toast('Calcul de l\'empreinte et sauvegarde…');
    await persistVideo(ctx.insp, ctx.room, r, 'camera');
    recBtn.textContent = '● Enregistrer'; recBtn.disabled = false;
    toast('Vidéo enregistrée et horodatée ✓');
    renderVideos();
  }
  recBtn.onclick = async () => {
    if (Cam.recording) return stopRec();
    try {
      Cam.record(); recCtx = { insp, room };
      Cam.mark(room.elements[step]?.name || room.name);
      recBtn.innerHTML = '<span class="pulse"></span> Arrêter';
    } catch (e) { toast(e.message); }
  };
  updatePrompt();

  // --- Import d'une vidéo filmée hors application
  $('#impVid').onchange = async ev => {
    const file = ev.target.files[0]; if (!file) return;
    toast('Import et calcul de l\'empreinte…');
    const duration = await new Promise(res => {
      const v = document.createElement('video'); v.preload = 'metadata';
      v.onloadedmetadata = () => { res(v.duration); URL.revokeObjectURL(v.src); };
      v.onerror = () => res(null); v.src = URL.createObjectURL(file);
    });
    const startedAt = new Date(file.lastModified || Date.now()).toISOString();
    await persistVideo(insp, room, { blob: file, mime: file.type, startedAt, endedAt: null, duration, fileName: file.name }, 'import');
    ev.target.value = ''; renderVideos(); toast('Vidéo importée ✓');
  };

  // --- Signalement de défaut
  const openDefect = async (fromCam) => {
    const at = new Date().toISOString();
    const photo = fromCam && Cam.active ? Cam.snapshot() : null;
    const videoTime = fromCam ? Cam.t : null;
    const videoId = fromCam && Cam.recording ? Cam.recId : null;
    if (videoId) Cam.mark('⚠ Défaut');
    const dlg = $('#dlg');
    dlg.innerHTML = `<form method="dialog" class="stack">
      <h2>Signaler un défaut</h2>
      ${photo ? `<img class="preview" src="${photo}" alt="">` : `<label class="btn block">📷 Prendre / choisir une photo<input type="file" accept="image/*" capture="environment" name="photo" hidden></label><img class="preview" id="phPrev" hidden alt="">`}
      <p class="small muted" style="margin:0">🕒 ${fmtDT(at)}${videoTime != null ? ` · à ${fmtDur(videoTime)} dans la vidéo en cours` : ''}</p>
      <label class="field">Élément concerné
        <select name="element">${room.elements.map((e, i) => `<option ${i === step ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}<option>Autre</option></select>
      </label>
      <label class="field">Gravité
        <select name="severity">${SEVERITIES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
      </label>
      <label class="field">Description<textarea name="description" placeholder="Ex. : trou de cheville 5 mm, rayure 20 cm sur le parquet, joint noirci…"></textarea></label>
      <div class="row"><button class="btn grow" value="cancel" formnovalidate>Annuler</button><button class="btn primary grow" value="ok">Enregistrer le défaut</button></div>
    </form>`;
    let manualPhoto = null;
    const fileIn = $('input[name=photo]', dlg);
    if (fileIn) fileIn.onchange = async () => {
      const f = fileIn.files[0]; if (!f) return;
      manualPhoto = await stampImage(f, `${label} · ${new Date().toLocaleString('fr-FR')}`);
      const p = $('#phPrev', dlg); p.src = manualPhoto; p.hidden = false;
    };
    dlg.showModal();
    dlg.onclose = async () => {
      if (dlg.returnValue !== 'ok') return;
      const f = $('form', dlg);
      room.defects.push({
        id: uid(), element: f.element.value, severity: f.severity.value, description: f.description.value.trim(),
        photo: photo || manualPhoto, at, videoId, videoTime,
      });
      const el = room.elements.find(e => e.name === f.element.value);
      if (el && (!el.state || STATE_RANK[el.state] > 3) && f.severity.value !== 'mineur') {
        el.state = 'mauvais';
        const sel = $(`.el[data-i="${room.elements.indexOf(el)}"] [data-state]`); if (sel) sel.value = 'mauvais';
        markWorse();
      }
      await saveInsp(insp); renderDefects(); toast('Défaut enregistré ✓');
    };
  };
  $('#defBtn').onclick = () => openDefect(true);
  $('#defManual').onclick = () => openDefect(false);
}

function videoFileName(insp, room, v) {
  const d = new Date(v.startedAt), p = n => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const ext = (v.mime || '').includes('mp4') ? 'mp4' : (v.mime || '').includes('quicktime') ? 'mov' : 'webm';
  return `EDL-${insp.type}-${slug(room.name)}-${ts}.${ext}`;
}

// ---------- Signatures & finalisation ----------
function signaturePad(canvas) {
  const ctx = canvas.getContext('2d');
  let drawing = false, dirty = false;
  const r0 = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  canvas.width = r0.width * dpr; canvas.height = r0.height * dpr;
  ctx.scale(dpr, dpr); ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111';
  const pos = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', e => { drawing = dirty = true; canvas.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pos(e)); ctx.lineTo(...pos(e)); ctx.stroke(); });
  canvas.addEventListener('pointermove', e => { if (drawing) { ctx.lineTo(...pos(e)); ctx.stroke(); } });
  ['pointerup', 'pointercancel'].forEach(t => canvas.addEventListener(t, () => { drawing = false; }));
  return {
    clear() { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.restore(); dirty = false; },
    get empty() { return !dirty; },
    data() { return canvas.toDataURL('image/png'); },
  };
}

async function viewSign(insp) {
  if (insp.finalizedAt) return go(`/i/${insp.id}/report`);
  const todo = insp.rooms.filter(r => !r.done);
  render(`
    <h1>Signatures & finalisation</h1>
    ${todo.length ? `<div class="card flat"><b>⚠ ${todo.length} pièce(s) non terminée(s) :</b> ${todo.map(r => `<a href="#/i/${insp.id}/r/${r.id}">${esc(r.name)}</a>`).join(', ')}</div>` : ''}
    <form id="sf" class="stack">
      <div class="card stack">
        <label class="field">Fait à (ville)<input type="text" name="place" required></label>
        <label class="field">Observations / réserves des parties<textarea name="remarks" placeholder="Facultatif"></textarea></label>
      </div>
      ${['landlord', 'tenant'].map(k => `<div class="card stack">
        <h2>${k === 'landlord' ? 'Bailleur / agence' : 'Locataire(s)'}</h2>
        <label class="field">Nom<input type="text" name="${k}Name" value="${esc(insp[k])}" required></label>
        <canvas class="sig" data-pad="${k}"></canvas>
        <div class="row between"><span class="small muted">Signez dans le cadre</span><button type="button" class="btn sm" data-clear="${k}">Effacer</button></div>
      </div>`).join('')}
      <div class="card">
        <label class="check"><input type="checkbox" name="agree" required> Les parties reconnaissent l'exactitude du présent état des lieux, établi contradictoirement.</label>
        <p class="small muted">Après finalisation, l'état des lieux est verrouillé et une empreinte numérique (SHA-256) du rapport est calculée : toute modification ultérieure serait détectée.</p>
        <button class="btn primary block">🔒 Finaliser et générer le rapport</button>
      </div>
    </form>`, 'Signatures');
  const pads = {};
  $$('[data-pad]').forEach(c => { pads[c.dataset.pad] = signaturePad(c); });
  $$('[data-clear]').forEach(b => b.onclick = () => pads[b.dataset.clear].clear());
  $('#sf').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    if (pads.landlord.empty || pads.tenant.empty) return toast('Les deux signatures sont requises.');
    if (todo.length && !confirm('Certaines pièces ne sont pas terminées. Finaliser quand même ?')) return;
    insp.landlord = f.landlordName.value.trim(); insp.tenant = f.tenantName.value.trim();
    insp.signatures = {
      place: f.place.value.trim(), remarks: f.remarks.value.trim(),
      landlord: { name: insp.landlord, image: pads.landlord.data() },
      tenant: { name: insp.tenant, image: pads.tenant.data() },
    };
    insp.finalizedAt = new Date().toISOString();
    insp.reportHash = await reportHash(insp);
    await saveInsp(insp);
    go(`/i/${insp.id}/report`);
  };
}

// Empreinte du rapport : tout le contenu sauf les champs techniques variables
function reportHash(insp) {
  const { reportHash: _h, updatedAt: _u, ...data } = insp;
  return sha256(JSON.stringify(data));
}

// ---------- Rapport ----------
async function viewReport(insp) {
  const linked = insp.linkedId ? await DB.get('inspections', insp.linkedId) : null;
  const integrity = insp.reportHash ? (await reportHash(insp)) === insp.reportHash : null;

  // Comparaison entrée / sortie
  const diffs = [];
  if (linked) {
    for (const room of insp.rooms) {
      const ref = linked.rooms.find(r => r.id === room.id);
      if (!ref) continue;
      for (const e of room.elements) {
        const re = ref.elements.find(x => x.name === e.name);
        if (re?.state && e.state && STATE_RANK[e.state] < STATE_RANK[re.state]) diffs.push({ room: room.name, element: e.name, from: re.state, to: e.state, comment: e.comment });
      }
    }
  }
  const allDefects = insp.rooms.flatMap(r => r.defects);
  const totalVideos = insp.rooms.reduce((n, r) => n + r.videos.length, 0);
  const totalDur = insp.rooms.reduce((n, r) => n + r.videos.reduce((m, v) => m + (v.duration || 0), 0), 0);

  const roomHtml = (room, i) => {
    const ref = linked?.rooms.find(r => r.id === room.id);
    return `<section class="card room">
      <h2>${i + 1}. ${esc(room.name)}</h2>
      <div class="tbl-scroll"><table>
        <thead><tr><th>Élément</th>${ref ? '<th>Entrée</th>' : ''}<th>État</th><th>Observations</th></tr></thead>
        <tbody>${room.elements.map(e => {
          const re = ref?.elements.find(x => x.name === e.name);
          return `<tr><td>${esc(e.name)}</td>${ref ? `<td>${re ? stateBadge(re.state) : '—'}</td>` : ''}<td>${stateBadge(e.state)}</td><td>${esc(e.comment)}</td></tr>`;
        }).join('')}</tbody>
      </table></div>
      ${room.defects.length ? `<h3 style="margin-top:14px">Défauts constatés (${room.defects.length})</h3>
        <div class="defects">${room.defects.map(d => `<figure>
          ${d.photo ? `<img src="${d.photo}" alt="">` : ''}
          <figcaption><b>${esc(d.element)}</b> ${sevBadge(d.severity)}<br>${esc(d.description)}<br>
          <span class="muted">🕒 ${fmtDT(d.at)}${d.videoTime != null ? ` · vidéo ${fmtDur(d.videoTime)}` : ''}</span></figcaption>
        </figure>`).join('')}</div>` : '<p class="small muted">Aucun défaut signalé.</p>'}
      <h3 style="margin-top:14px">Vidéos (${room.videos.length})</h3>
      ${room.videos.length ? `<div class="tbl-scroll"><table><thead><tr><th>Début</th><th>Durée</th><th>Fichier & empreinte SHA-256</th></tr></thead><tbody>
        ${room.videos.map(v => `<tr><td>${fmtDT(v.startedAt)}${v.source === 'import' ? '<br><span class="badge warn">importée</span>' : ''}</td><td>${fmtDur(v.duration)}</td>
          <td><a data-dlv="${v.id}" data-name="${esc(videoFileName(insp, room, v))}" href="#" class="no-print">⬇ </a>${esc(videoFileName(insp, room, v))}<div class="mono muted">${v.sha256}</div>
          ${v.markers?.length ? `<div class="small muted">${v.markers.map(m => `${fmtDur(m.t)} ${esc(m.label)}`).join(' · ')}</div>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="small muted">Aucune vidéo.</p>'}
    </section>`;
  };

  render(`
    <div class="row no-print" style="margin-bottom:12px">
      <a class="btn" href="#/i/${insp.id}">← Retour</a>
      <button class="btn primary" id="print">🖨 Imprimer / PDF</button>
      <button class="btn" id="export">⬇ Exporter les données</button>
      <button class="btn" id="dlAll" ${totalVideos ? '' : 'disabled'}>⬇ Toutes les vidéos</button>
    </div>
    <article class="report">
      <section class="card">
        <h1>État des lieux ${insp.type === 'sortie' ? 'de sortie' : "d'entrée"}</h1>
        ${!insp.finalizedAt ? '<p><span class="badge warn">BROUILLON — non signé</span></p>' : ''}
        <table>
          <tr><th>Logement</th><td>${esc(insp.address)} (${insp.furnished === 'meuble' ? 'meublé' : 'vide'})</td></tr>
          <tr><th>Bailleur</th><td>${esc(insp.landlord || '—')}</td></tr>
          <tr><th>Locataire(s)</th><td>${esc(insp.tenant || '—')}</td></tr>
          <tr><th>Début de la visite</th><td>${fmtDT(insp.createdAt)}</td></tr>
          <tr><th>Finalisé et signé</th><td>${fmtDT(insp.finalizedAt)}${insp.signatures?.place ? ` à ${esc(insp.signatures.place)}` : ''}</td></tr>
          ${linked ? `<tr><th>État des lieux d'entrée</th><td>${fmtDT(linked.createdAt)}</td></tr>` : ''}
          <tr><th>Synthèse</th><td>${insp.rooms.length} pièces · ${allDefects.length} défaut(s) · ${totalVideos} vidéo(s) (${fmtDur(totalDur)})</td></tr>
        </table>
      </section>

      ${linked ? `<section class="card">
        <h2>Écarts entre l'entrée et la sortie</h2>
        ${diffs.length ? `<div class="tbl-scroll"><table><thead><tr><th>Pièce</th><th>Élément</th><th>Entrée</th><th>Sortie</th><th>Observation</th></tr></thead><tbody>
          ${diffs.map(d => `<tr><td>${esc(d.room)}</td><td>${esc(d.element)}</td><td>${stateBadge(d.from)}</td><td>${stateBadge(d.to)}</td><td>${esc(d.comment)}</td></tr>`).join('')}
        </tbody></table></div>` : '<p>✅ Aucune dégradation constatée par rapport à l\'entrée.</p>'}
        <p class="small muted">Seuls les éléments dont l'état s'est dégradé sont listés. L'usure normale liée à l'usage (vétusté) ne peut être imputée au locataire.</p>
      </section>` : ''}

      <section class="card">
        <h2>Compteurs & clés</h2>
        <table>${METERS.map(([k, l]) => `<tr><th>${l}</th><td>${esc(insp.meters?.[k] || '—')}</td></tr>`).join('')}</table>
      </section>

      ${insp.rooms.map(roomHtml).join('')}

      <section class="card room">
        <h2>Signatures</h2>
        ${insp.signatures ? `
          ${insp.signatures.remarks ? `<p><b>Observations des parties :</b> ${esc(insp.signatures.remarks)}</p>` : ''}
          <div class="sigs">
            <div><b>Bailleur / agence</b><br>${esc(insp.signatures.landlord.name)}<img src="${insp.signatures.landlord.image}" alt="Signature du bailleur"></div>
            <div><b>Locataire(s)</b><br>${esc(insp.signatures.tenant.name)}<img src="${insp.signatures.tenant.image}" alt="Signature du locataire"></div>
          </div>
          <p class="small">Fait à ${esc(insp.signatures.place)}, le ${fmtDT(insp.finalizedAt)}, en autant d'exemplaires que de parties.</p>`
          : `<p class="muted">Non signé. <a class="no-print" href="#/i/${insp.id}/sign">Passer aux signatures</a></p>`}
      </section>

      <section class="card small">
        <h2>Intégrité</h2>
        <p>Chaque vidéo est horodatée dans l'image (date, heure, pièce) et identifiée par son empreinte SHA-256 : un fichier modifié ne produit plus la même empreinte.</p>
        ${insp.reportHash ? `<p>Empreinte du rapport : <span class="mono">${insp.reportHash}</span><br>
          Vérification : ${integrity ? '<span class="badge ok">✓ contenu intact</span>' : '<span class="badge danger">⚠ contenu modifié depuis la signature</span>'}</p>` : ''}
        <p class="muted">Document généré le ${fmtDT(new Date().toISOString())} avec ÉDL Vidéo.</p>
      </section>
    </article>`, 'Rapport');

  $('#print').onclick = () => window.print();
  $('#export').onclick = () => {
    const blob = new Blob([JSON.stringify(insp, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `EDL-${insp.type}-${slug(insp.address || 'logement')}-${insp.createdAt.slice(0, 10)}.json`);
  };
  const dlVideo = async (id, name) => { const v = await DB.get('videos', id); if (v) downloadBlob(v.blob, name); };
  $$('[data-dlv]').forEach(a => a.onclick = e => { e.preventDefault(); dlVideo(a.dataset.dlv, a.dataset.name); });
  $('#dlAll').onclick = async () => {
    for (const a of $$('[data-dlv]')) { await dlVideo(a.dataset.dlv, a.dataset.name); await new Promise(r => setTimeout(r, 600)); }
  };
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ---------- Démarrage ----------
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
routing = routing.then(route);
