/*!
 * Widget de chat de Quot. Se incluye con una sola línea en el sitio:
 *   <script src="https://TU-API.onrender.com/widget.js" defer></script>
 * Opcionales: data-api (URL de la API; por defecto el origen del script), data-title, data-color, data-color-dark.
 */
(function () {
  'use strict';
  if (window.__quotChat) return;
  window.__quotChat = true;

  var script = document.currentScript || document.querySelector('script[src*="widget.js"]');
  var API = ((script && script.getAttribute('data-api')) || (script && script.src ? new URL(script.src).origin : '')).replace(/\/$/, '');
  var TITLE = (script && script.getAttribute('data-title')) || 'Quot · Asistente';
  // Verde tipo WhatsApp: botón flotante en verde brillante y el resto (cabecera, burbujas, enviar) en un verde más oscuro para que el texto blanco se lea bien.
  var CUSTOM = script && script.getAttribute('data-color');
  var COLOR = CUSTOM || '#25D366';
  var DARK = (script && script.getAttribute('data-color-dark')) || CUSTOM || '#128C7E';
  var KEY = 'quot_chat_token';
  var WELCOME = '¡Hola! ¿En qué te puedo ayudar?';
  var token = null, lastId = 0, status = 'bot', open = false, busy = false, pollTimer = null, unread = 0;

  function store(k, v) { try { v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } }
  function load(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }

  // ---------- UI (Shadow DOM: no choca con los estilos de WooCommerce)
  var host = document.createElement('div');
  host.style.cssText = 'position:fixed;z-index:2147483000;right:0;bottom:0;';
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>' +
    ':host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
    '.fab{position:fixed;right:20px;bottom:20px;width:58px;height:58px;border-radius:50%;border:0;background:' + COLOR + ';color:#fff;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center}' +
    '.fab svg{width:28px;height:28px}.dot{position:absolute;top:2px;right:2px;min-width:18px;height:18px;border-radius:9px;background:#dc2626;color:#fff;font-size:11px;line-height:18px;text-align:center;display:none;padding:0 4px}' +
    '.panel{position:fixed;right:20px;bottom:90px;width:370px;max-width:calc(100vw - 24px);height:540px;max-height:calc(100vh - 110px);background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.28);display:none;flex-direction:column;overflow:hidden}' +
    '.panel.on{display:flex}' +
    '.head{background:' + DARK + ';color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between}' +
    '.head b{font-size:15px}.head small{display:block;opacity:.85;font-size:12px;margin-top:2px}' +
    '.x{background:none;border:0;color:#fff;font-size:24px;cursor:pointer;line-height:1}' +
    '.msgs{flex:1;overflow-y:auto;padding:14px;background:#f1f5f9;display:flex;flex-direction:column;gap:8px}' +
    '.m{max-width:85%;padding:9px 12px;border-radius:12px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}' +
    '.m.user{align-self:flex-end;background:' + DARK + ';color:#fff;border-bottom-right-radius:3px}' +
    '.m.bot{align-self:flex-start;background:#fff;color:#0f172a;border-bottom-left-radius:3px;box-shadow:0 1px 2px rgba(0,0,0,.08)}' +
    '.m.agent{align-self:flex-start;background:#dcfce7;color:#14532d;border-bottom-left-radius:3px}' +
    '.m.agent .who{display:block;font-size:11px;font-weight:600;margin-bottom:2px}' +
    '.m.sys{align-self:center;background:transparent;color:#64748b;font-size:12px;text-align:center}' +
    '.m.temp{opacity:.6}.m a{color:inherit;text-decoration:underline}' +
    '.typing{align-self:flex-start;color:#64748b;font-size:13px;padding:2px 6px}' +
    'form{display:flex;gap:8px;padding:10px;border-top:1px solid #e2e8f0;background:#fff}' +
    'textarea{flex:1;resize:none;border:1px solid #cbd5e1;border-radius:10px;padding:9px 10px;font-size:14px;max-height:90px;outline:none}' +
    'textarea:focus{border-color:' + DARK + '}' +
    '.send{border:0;background:' + DARK + ';color:#fff;border-radius:10px;padding:0 16px;font-size:14px;cursor:pointer}.send:disabled{opacity:.5;cursor:default}' +
    '.foot{font-size:11px;color:#94a3b8;text-align:center;padding:0 0 8px;background:#fff}' +
    '.panel{height:min(540px,calc(100dvh - 110px));max-height:calc(100vh - 110px);right:max(20px,env(safe-area-inset-right));bottom:calc(90px + env(safe-area-inset-bottom))}' +
    '.fab{right:max(20px,env(safe-area-inset-right));bottom:calc(20px + env(safe-area-inset-bottom))}' +
    '.msgs{overscroll-behavior:contain;-webkit-overflow-scrolling:touch}' +
    '@media(max-width:520px){.panel{inset:0;right:0;bottom:0;width:100%;max-width:100%;height:100dvh;max-height:100dvh;border-radius:0}' +
    '.head{padding:12px 14px;padding-top:calc(12px + env(safe-area-inset-top))}.x{font-size:32px;min-width:44px;min-height:44px}' +
    'textarea{font-size:16px}.send{min-height:44px;padding:0 18px}.m{font-size:15px;max-width:88%}' +
    'form{padding:10px;padding-bottom:calc(10px + env(safe-area-inset-bottom))}.foot{padding-bottom:calc(8px + env(safe-area-inset-bottom))}' +
    '.fab{right:14px;bottom:calc(14px + env(safe-area-inset-bottom))}.fab.hide{display:none}}' +
    '@media(max-height:480px) and (orientation:landscape){.foot{display:none}.head small{display:none}}' +
    '@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}' +
    '</style>' +
    '<button class="fab" aria-label="Abrir chat de Quot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span class="dot"></span></button>' +
    '<section class="panel" role="dialog" aria-label="Chat con Quot"><div class="head"><div><b></b><small>Respuestas automáticas · puedes pedir un ejecutivo</small></div><button class="x" aria-label="Cerrar chat">×</button></div>' +
    '<div class="msgs" aria-live="polite"></div>' +
    '<form><textarea rows="1" maxlength="1000" placeholder="Escribe tu mensaje…" aria-label="Mensaje"></textarea><button class="send" type="submit">Enviar</button></form>' +
    '<div class="foot">No compartas claves ni datos de pago por este chat</div></section>';
  var $ = function (s) { return root.querySelector(s); };
  var fab = $('.fab'), dot = $('.dot'), panel = $('.panel'), msgs = $('.msgs'), form = $('form'), input = $('textarea'), sendBtn = $('.send');
  $('.head b').textContent = TITLE;

  function linkify(el, text) {
    var re = /(https?:\/\/[^\s<>"')]+)/g, last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
      var a = document.createElement('a');
      a.href = m[1]; a.textContent = m[1]; a.target = '_blank'; a.rel = 'noopener noreferrer';
      el.appendChild(a);
      last = m.index + m[1].length;
    }
    if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
  }
  function bubble(kind, text, opts) {
    var el = document.createElement('div');
    el.className = 'm ' + kind + (opts && opts.temp ? ' temp' : '');
    if (kind === 'agent') { var w = document.createElement('span'); w.className = 'who'; w.textContent = 'Ejecutivo Quot'; el.appendChild(w); }
    linkify(el, text);
    if (opts && opts.temp) el.setAttribute('data-temp', '1');
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  }
  function typing(on) {
    var t = msgs.querySelector('.typing');
    if (on && !t) { t = document.createElement('div'); t.className = 'typing'; t.textContent = 'Escribiendo…'; msgs.appendChild(t); msgs.scrollTop = msgs.scrollHeight; }
    if (!on && t) t.remove();
  }
  function setDot() { dot.style.display = unread > 0 && !open ? 'block' : 'none'; dot.textContent = unread > 9 ? '9+' : String(unread); }

  // ---------- API
  function call(method, path, body) {
    return fetch(API + '/api/chatbot' + path, {
      method: method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || 'Error ' + r.status); e.status = r.status; throw e; }
        return j;
      });
    });
  }
  function newSession() {
    return call('POST', '/session').then(function (j) {
      token = j.token; store(KEY, token); lastId = 0; status = 'bot'; msgs.innerHTML = '';
      bubble('bot', j.welcome || '¡Hola! ¿En qué te puedo ayudar?');
    });
  }
  function render(list) {
    msgs.querySelectorAll('[data-temp]').forEach(function (n) { n.remove(); });
    list.forEach(function (m) {
      lastId = Math.max(lastId, m.id);
      if (m.role === 'user') bubble('user', m.content);
      else if (m.role === 'agent') { bubble('agent', m.content); if (!open) { unread++; setDot(); } }
      else bubble('bot', m.content);
    });
  }
  function sync() {
    return call('GET', '/messages?after=' + lastId).then(function (j) {
      var firstLoad = lastId === 0;
      if (firstLoad && j.messages.length) { msgs.innerHTML = ''; }
      render(j.messages);
      if (status !== j.status) { status = j.status; if (status === 'handoff') bubble('sys', 'Un ejecutivo de Quot te atenderá en este chat.'); }
      schedule();
    });
  }
  function schedule() {
    clearTimeout(pollTimer);
    if (token && status === 'handoff') pollTimer = setTimeout(function () { sync().catch(function () { schedule(); }); }, open ? 3000 : 8000);
  }

  function start() {
    token = load(KEY);
    if (!token) return newSession();
    return sync().catch(function (e) { if (e.status === 401) { token = null; store(KEY, null); return newSession(); } throw e; }).then(function () {
      if (!msgs.children.length) bubble('bot', WELCOME);
    });
  }

  function send(text) {
    busy = true; sendBtn.disabled = true;
    bubble('user', text, { temp: true });
    typing(true);
    return call('POST', '/message', { text: text })
      .then(function () { typing(false); return sync(); })
      .catch(function (e) {
        typing(false);
        msgs.querySelectorAll('[data-temp]').forEach(function (n) { n.remove(); });
        if (e.status === 401) { token = null; store(KEY, null); bubble('sys', 'Tu sesión expiró. Escribe de nuevo para continuar.'); return newSession(); }
        bubble('sys', e.message || 'No pude enviar tu mensaje. Intenta de nuevo.');
        input.value = text;
      })
      .then(function () { busy = false; sendBtn.disabled = false; input.focus(); });
  }

  function toggle(v) {
    open = v; panel.classList.toggle('on', v); fab.classList.toggle('hide', v); fab.setAttribute('aria-label', v ? 'Cerrar chat de Quot' : 'Abrir chat de Quot');
    if (v) {
      fit(); unread = 0; setDot();
      if (!msgs.children.length) start().catch(function () { bubble('sys', 'El chat no está disponible por ahora. Escríbenos a contacto@quot.cl'); });
      setTimeout(function () { input.focus(); }, 50);
    }
  }
  // Teclado virtual en móviles: ajusta el alto del panel al área visible
  function fit() {
    var vv = window.visualViewport;
    if (!vv || window.innerWidth > 520) { panel.style.height = ''; panel.style.top = ''; panel.style.bottom = ''; return; }
    panel.style.height = vv.height + 'px'; panel.style.top = vv.offsetTop + 'px'; panel.style.bottom = 'auto';
    msgs.scrollTop = msgs.scrollHeight;
  }
  if (window.visualViewport) { window.visualViewport.addEventListener('resize', fit); window.visualViewport.addEventListener('scroll', fit); }
  window.addEventListener('orientationchange', function () { setTimeout(fit, 200); });
  fab.addEventListener('click', function () { toggle(!open); });
  $('.x').addEventListener('click', function () { toggle(false); });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var t = input.value.trim();
    if (!t || busy) return;
    input.value = ''; input.style.height = 'auto';
    send(t);
  });
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  input.addEventListener('input', function () { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 90) + 'px'; });

  document.body.appendChild(host);
  // Si ya había una conversación derivada en esta pestaña, seguir recibiendo respuestas del ejecutivo
  if (load(KEY)) {
    token = load(KEY);
    sync().then(function () { if (!msgs.children.length) bubble('bot', WELCOME); }).catch(function () {});
  }
})();
