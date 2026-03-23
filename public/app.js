/* ── ESTADO ── */
var attachedFiles = [];
var chatHistory   = [];
var isTyping      = false;
var typingEl      = null;
var toastTimer;

var AI_AVATAR_ASSET = 'logo-smart.png';

function getAiAvatarHtml(extraClass) {
  var cls = extraClass ? ' ' + extraClass : '';
  return '<img src="./assets/logo-smart.png"' + 'alt="SmartAI"' + 'class="brand-logo-img"' + 'onerror="this.style.display=\'none\';' + 'this.nextElementSibling.style.display=\'flex\';"><span class="brand-logo-fallback" style="display:none;">✦</span>';
}


/* ═══════════════════════════════
   AUTH
═══════════════════════════════ */
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(function (btn, i) {
    btn.classList.toggle('active', (i === 0 && tab === 'login') || (i === 1 && tab === 'signup'));
  });
  document.getElementById('loginForm').style.display   = tab === 'login'  ? 'block' : 'none';
  document.getElementById('signupForm').style.display  = tab === 'signup' ? 'block' : 'none';
  document.getElementById('authHeading').textContent   = tab === 'login'  ? 'Bem-vindo de volta' : 'Crie sua conta';
  document.getElementById('authSub').textContent       = tab === 'login'
    ? 'Acesso interno — faça login para continuar'
    : 'Solicite acesso ao administrador';
}

function goToChat() {
  document.getElementById('loginScreen').classList.remove('active');
  document.getElementById('chatScreen').classList.add('active');
}

function logout() {
  closePanel('profilePanel');
  document.getElementById('chatScreen').classList.remove('active');
  document.getElementById('loginScreen').classList.add('active');
}

/* ═══════════════════════════════
   CHAT — NAVEGAÇÃO
═══════════════════════════════ */
function newChat() {
  chatHistory   = [];
  attachedFiles = [];
  document.getElementById('welcomeState').style.display = '';
  document.getElementById('messageList').style.display  = 'none';
  document.getElementById('messageList').innerHTML      = '';
  document.getElementById('filePreview').innerHTML      = '';
  document.getElementById('filePreview').classList.remove('visible');
  document.querySelectorAll('.chat-item').forEach(function (el) {
    el.classList.remove('active');
  });
}

function filterChats(query) {
  document.querySelectorAll('.chat-item').forEach(function (el) {
    var title = el.dataset.title || '';
    el.style.display = title.toLowerCase().indexOf(query.toLowerCase()) > -1 ? '' : 'none';
  });
}

/* ═══════════════════════════════
   CHAT — MENSAGENS
═══════════════════════════════ */
function sendMessage() {
  var input = document.getElementById('chatInput');
  var text  = input.value.trim();

  if (!text && attachedFiles.length === 0) return;
  if (isTyping) return;

  document.getElementById('welcomeState').style.display = 'none';
  document.getElementById('messageList').style.display  = 'block';

  /* Monta preview do texto da mensagem do usuário */
  var attachInfo = attachedFiles.length
    ? ' [Anexo: ' + attachedFiles.map(function (f) { return f.name; }).join(', ') + ']'
    : '';
  var msgText = text + attachInfo;

  appendMessage('user', msgText);
  chatHistory.push({ role: 'user', content: text || '(arquivo anexado)' });

  var filesToSend = attachedFiles.slice();
  input.value        = '';
  input.style.height = 'auto';
  attachedFiles      = [];
  document.getElementById('filePreview').innerHTML = '';
  document.getElementById('filePreview').classList.remove('visible');

  showTyping();

  /* ── Monta requisição: FormData se tiver arquivos, JSON se não tiver ── */
  var fetchOptions;
  if (filesToSend.length > 0) {
    var form = new FormData();
    form.append('question', text || '');
    form.append('history', JSON.stringify(chatHistory.slice(-10)));
    filesToSend.forEach(function (f) { form.append('files', f); });
    fetchOptions = { method: 'POST', body: form };
  } else {
    fetchOptions = {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ question: text, history: chatHistory.slice(-10) }),
    };
  }

  fetch('/api/ask', fetchOptions)
  .then(function (res) { return res.json(); })
  .then(function (data) {
    removeTyping();

    if (data.error) {
      appendMessage('ai', '⚠️ ' + data.error);
      return;
    }

    /* Renderiza resposta com markdown */
    var html = formatResponse(data.answer);

    /* Fontes do Notion */
    if (data.sources && data.sources.length > 0) {
      html += '<div class="msg-sources">'
            + '<div class="msg-sources-label">Fontes consultadas:</div>'
            + data.sources.map(function (s) {
                return '<a class="msg-source-link" href="' + s.url + '" target="_blank" rel="noopener">'
                     + '📄 ' + s.title + '</a>';
              }).join('')
            + '</div>';
    }

    /* Aviso de arquivos não suportados */
    if (data.unsupported && data.unsupported.length > 0) {
      html += '<div class="msg-sources">'
            + '<div class="msg-sources-label" style="color:var(--danger);">Tipo não suportado (ignorados):</div>'
            + data.unsupported.map(function (n) {
                return '<span class="msg-source-link" style="opacity:.6;">⚠️ ' + n + '</span>';
              }).join('')
            + '</div>';
    }

    appendMessage('ai', html);
    chatHistory.push({ role: 'assistant', content: data.answer });
  })
  .catch(function (err) {
    removeTyping();
    appendMessage('ai', '⚠️ Erro de conexão. Verifique se o servidor está rodando.');
    console.error(err);
  });
}

/* Converte markdown básico em HTML para exibir as respostas */
function formatResponse(text) {
  return text
    /* blocos de código */
    .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    /* negrito */
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    /* itálico */
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    /* títulos h3 */
    .replace(/^### (.+)$/gm, '<h3 style="margin:12px 0 6px;font-size:13px;font-weight:600;">$1</h3>')
    /* títulos h2 */
    .replace(/^## (.+)$/gm, '<h3 style="margin:14px 0 6px;font-size:14px;font-weight:600;">$1</h3>')
    /* lista com hífen */
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    /* agrupa li soltos em ul */
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul style="margin:8px 0;padding-left:18px;">$&</ul>')
    /* quebras de linha */
    .replace(/\n{2,}/g, '</p><p style="margin:8px 0;">')
    .replace(/\n/g, '<br>')
    /* envolve em parágrafo */
    .replace(/^(.)/s, '<p style="margin:0;">$1')
    + '</p>';
}

function appendMessage(role, text, animate) {
  if (animate === undefined) animate = true;

  var list   = document.getElementById('messageList');
  var isUser = role === 'user';
  var div    = document.createElement('div');

  div.className = 'message' + (isUser ? ' user-msg' : '');
  if (animate) div.style.animation = 'msgIn 0.3s ease both';

  var actionsHtml = !isUser
    ? '<div class="msg-actions">'
    +   '<button class="msg-action-btn" onclick="copyMsg(this)">'
    +     '<svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">'
    +       '<rect x="9" y="9" width="13" height="13" rx="2"/>'
    +       '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'
    +     '</svg> Copiar'
    +   '</button>'
    +   '<button class="msg-action-btn">'
    +     '<svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">'
    +       '<path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/>'
    +       '<path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>'
    +     '</svg> Útil'
    +   '</button>'
    + '</div>'
    : '';

  div.innerHTML =
    '<div class="msg-avatar ' + (isUser ? 'user' : 'ai') + '">' + (isUser ? '?' : getAiAvatarHtml()) + '</div>'
    + '<div class="msg-content">'
    +   '<div class="msg-name">' + (isUser ? 'Você' : 'SmartAI') + (!isUser ? ' <span class="badge">AI</span>' : '') + '</div>'
    +   '<div class="msg-bubble' + (isUser ? ' user-bubble' : '') + '">' + text + '</div>'
    +   actionsHtml
    + '</div>';

  list.appendChild(div);
  list.parentElement.scrollTop = list.parentElement.scrollHeight;
}

function copyMsg(btn) {
  var bubble = btn.closest('.msg-content').querySelector('.msg-bubble');
  navigator.clipboard.writeText(bubble.textContent).catch(function () {});
  showToast('Copiado!');
}

function showTyping() {
  isTyping  = true;
  var list  = document.getElementById('messageList');
  typingEl  = document.createElement('div');
  typingEl.className = 'message';
  typingEl.id        = 'typingMsg';
  typingEl.innerHTML =
    '<div class="msg-avatar ai">' + getAiAvatarHtml() + '</div>'
    + '<div class="msg-content">'
    +   '<div class="msg-name">SmartAI <span class="badge">AI</span></div>'
    +   '<div class="typing-indicator">'
    +     '<div class="typing-dot"></div>'
    +     '<div class="typing-dot"></div>'
    +     '<div class="typing-dot"></div>'
    +   '</div>'
    + '</div>';
  list.appendChild(typingEl);
  list.parentElement.scrollTop = list.parentElement.scrollHeight;
}

function removeTyping() {
  isTyping = false;
  var el   = document.getElementById('typingMsg');
  if (el) el.remove();
}

function clearChat() {
  if (!chatHistory.length) return;
  newChat();
  showToast('Chat limpo');
}

/* ═══════════════════════════════
   INPUT
═══════════════════════════════ */
function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

/* ═══════════════════════════════
   ARQUIVOS
═══════════════════════════════ */
function handleFileAttach(e) {
  attachedFiles = attachedFiles.concat(Array.from(e.target.files));
  renderFilePreview();
  e.target.value = '';
}

function renderFilePreview() {
  var area = document.getElementById('filePreview');
  area.innerHTML = '';
  attachedFiles.forEach(function (f, i) {
    var chip       = document.createElement('div');
    chip.className = 'file-chip';
    chip.innerHTML =
      '<span>📎 ' + f.name + '</span>'
      + '<span class="file-chip-remove" onclick="removeFile(' + i + ')">✕</span>';
    area.appendChild(chip);
  });
  area.classList.toggle('visible', attachedFiles.length > 0);
}

function removeFile(i) {
  attachedFiles.splice(i, 1);
  renderFilePreview();
}

/* ═══════════════════════════════
   PANELS
═══════════════════════════════ */
function openThemes()  { document.getElementById('themePanel').classList.add('open'); }
function openProfile() { document.getElementById('profilePanel').classList.add('open'); }

function closePanel(id) {
  document.getElementById(id).classList.remove('open');
}

function closePanelOnOverlay(e, id) {
  if (e.target === e.currentTarget) closePanel(id);
}

/* ═══════════════════════════════
   TEMA
═══════════════════════════════ */
function applyTheme(name) {
  document.body.className = name ? 'theme-' + name : '';
  document.querySelectorAll('.theme-option').forEach(function (opt) {
    opt.classList.toggle('selected', opt.id === 'theme-' + (name || 'default'));
  });
  var labels = {
    '': 'Padrão',
    midnight: 'Meia-noite',
    ocean: 'Oceano',
    forest: 'Floresta',
    rose: 'Rosa',
    light: 'Claro'
  };
  showToast('Tema: ' + labels[name]);
  try { localStorage.setItem('nexus-theme', name); } catch (e) {}
}

/* ═══════════════════════════════
   PERFIL
═══════════════════════════════ */
function saveName() {
  var val = document.getElementById('inputNewName').value.trim();
  if (!val) return;

  document.getElementById('profileNameDisplay').textContent = val;
  document.getElementById('sidebarUserName').textContent    = val;

  var initials = val.split(' ').map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
  document.getElementById('bigAvatar').textContent     = initials;
  document.getElementById('sidebarAvatar').textContent = initials;

  document.getElementById('inputNewName').value = '';
  showToast('Nome atualizado!');
}

/* ═══════════════════════════════
   TOAST
═══════════════════════════════ */
function showToast(msg) {
  clearTimeout(toastTimer);
  var toast = document.getElementById('toast');
  document.getElementById('toastMsg').textContent = msg;
  toast.classList.add('visible');
  toastTimer = setTimeout(function () {
    toast.classList.remove('visible');
  }, 2500);
}

/* ═══════════════════════════════
   INIT — restaurar tema salvo
═══════════════════════════════ */
(function () {
  try {
    var saved = localStorage.getItem('nexus-theme');
    if (saved !== null) applyTheme(saved);
  } catch (e) {}
})();