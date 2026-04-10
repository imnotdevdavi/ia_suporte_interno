var attachedFiles = [];
var currentUser = null;
var currentChatId = null;
var currentMessages = [];
var chatHistory = [];
var chatList = [];
var isTyping = false;
var typingEl = null;
var toastTimer;
var MAX_ATTACHMENT_FILES = 5;
var MAX_ATTACHMENT_FILE_BYTES = 30 * 1024 * 1024;
var MAX_ATTACHMENT_TOTAL_BYTES = 30 * 1024 * 1024;
var MAX_PROFILE_PHOTO_BYTES = 30 * 1024 * 1024;
var ATTACHMENT_UPLOAD_MODE = 'multipart';
var blobUploadModulePromise = null;

var AI_AVATAR_ASSET = 'logo-smart.png';

function formatByteSize(bytes) {
  var value = Number(bytes || 0);
  if (value < 1024 * 1024) {
    return Math.max(1, Math.round(value / 1024)) + 'KB';
  }

  return (value / (1024 * 1024)).toFixed(1).replace(/\.0$/, '') + 'MB';
}

function applyClientConfig(config) {
  var uploads = config && config.uploads ? config.uploads : {};
  var limits = config && config.limits ? config.limits : {};

  if (typeof uploads.attachmentMode === 'string' && uploads.attachmentMode) {
    ATTACHMENT_UPLOAD_MODE = uploads.attachmentMode;
  }

  if (typeof limits.maxAttachmentFiles === 'number' && limits.maxAttachmentFiles > 0) {
    MAX_ATTACHMENT_FILES = limits.maxAttachmentFiles;
  }
  if (typeof limits.maxAttachmentFileBytes === 'number' && limits.maxAttachmentFileBytes > 0) {
    MAX_ATTACHMENT_FILE_BYTES = limits.maxAttachmentFileBytes;
  }
  if (typeof limits.maxAttachmentTotalBytes === 'number' && limits.maxAttachmentTotalBytes > 0) {
    MAX_ATTACHMENT_TOTAL_BYTES = limits.maxAttachmentTotalBytes;
  }
  if (typeof limits.maxProfilePhotoBytes === 'number' && limits.maxProfilePhotoBytes > 0) {
    MAX_PROFILE_PHOTO_BYTES = limits.maxProfilePhotoBytes;
  }

  updateInputHint();
}

function updateInputHint() {
  var hintEl = document.getElementById('inputHint');
  if (!hintEl) return;

  var hint = 'Enter para enviar · Shift+Enter nova linha · Até '
    + MAX_ATTACHMENT_FILES + ' arquivos e '
    + formatByteSize(MAX_ATTACHMENT_TOTAL_BYTES) + ' por envio';

  if (ATTACHMENT_UPLOAD_MODE === 'blob_direct') {
    hint += ' · upload direto habilitado';
  }

  hintEl.textContent = hint;
}

async function loadClientConfig() {
  try {
    var response = await fetch('/api/client-config');
    var payload = await safeReadJson(response);
    if (response.ok) {
      applyClientConfig(payload);
    }
  } catch (error) {}
}

function sanitizeUploadSegment(value, fallback) {
  var cleaned = String(value || fallback || 'arquivo')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

  return cleaned || (fallback || 'arquivo');
}

function buildDirectUploadPath(file, chatId) {
  if (!currentUser || !currentUser.id) {
    throw new Error('Sua sessão expirou. Faça login novamente para anexar arquivos.');
  }

  var fileName = String(file && file.name ? file.name : 'arquivo');
  var extensionIndex = fileName.lastIndexOf('.');
  var extension = extensionIndex > 0 ? fileName.slice(extensionIndex).replace(/[^a-zA-Z0-9.]+/g, '').slice(0, 12) : '';
  var baseName = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName;
  var safeName = sanitizeUploadSegment(baseName, 'arquivo');
  var folder = chatId ? ('chat-' + chatId) : ('draft-' + Date.now());

  return 'incoming/user-' + currentUser.id + '/' + sanitizeUploadSegment(folder, 'draft') + '/' + safeName + extension;
}

async function getBlobUploadClient() {
  if (!blobUploadModulePromise) {
    blobUploadModulePromise = import('/blob-upload-client.js');
  }

  return blobUploadModulePromise;
}

async function uploadAttachmentFilesDirect(files, chatId) {
  if (!files || !files.length) return [];

  var blobClient = await getBlobUploadClient();
  var uploaded = [];

  for (var index = 0; index < files.length; index += 1) {
    var file = files[index];
    showToast('Enviando anexo ' + (index + 1) + ' de ' + files.length + '...');

    var blob = await blobClient.upload(buildDirectUploadPath(file, chatId), file, {
      access: 'private',
      handleUploadUrl: '/api/blob/upload',
      multipart: file.size >= 5 * 1024 * 1024,
      contentType: file.type || undefined
    });

    uploaded.push({
      storagePath: blob.url,
      pathname: blob.pathname,
      originalName: file.name,
      displayName: file.name,
      mimeType: blob.contentType || file.type || '',
      size: file.size || 0
    });
  }

  return uploaded;
}

function getAiAvatarHtml(extraClass) {
  var cls = extraClass ? ' ' + extraClass : '';
  return '<img src="./assets/logo-smart.png" alt="SmartAI" class="brand-logo-img' + cls + '" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\';"><span class="brand-logo-fallback" style="display:none;">✦</span>';
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(function (btn, i) {
    btn.classList.toggle('active', (i === 0 && tab === 'login') || (i === 1 && tab === 'signup'));
  });
  document.getElementById('loginForm').style.display = tab === 'login' ? 'block' : 'none';
  document.getElementById('signupForm').style.display = tab === 'signup' ? 'block' : 'none';
  document.getElementById('authHeading').textContent = tab === 'login' ? 'Bem-vindo de volta' : 'Crie sua conta';
  document.getElementById('authSub').textContent = tab === 'login'
    ? 'Acesso interno — faça login para continuar'
    : 'Crie sua conta para salvar chats, anexos e preferências';
}

function goToChat() {
  document.getElementById('loginScreen').classList.remove('active');
  document.getElementById('chatScreen').classList.add('active');
}

function goToLogin() {
  document.getElementById('chatScreen').classList.remove('active');
  document.getElementById('loginScreen').classList.add('active');
}

function loginWithGoogle() {
  window.location.href = '/api/auth/google';
}

async function submitLogin() {
  var email = document.getElementById('loginEmail').value.trim();
  var password = document.getElementById('loginPassword').value;
  var button = document.getElementById('btnLogin');

  if (!email || !password) {
    showToast('Preencha e-mail e senha.');
    return;
  }

  setButtonLoading(button, true, 'Entrando...');

  try {
    var response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password })
    });
    var payload = await safeReadJson(response);

    if (!response.ok) {
      throw new Error(payload.error || 'Não foi possível entrar.');
    }

    document.getElementById('loginPassword').value = '';
    await handleAuthenticatedUser(payload.user);
    showToast('Login realizado!');
  } catch (error) {
    showToast(error.message || 'Não foi possível entrar.');
  } finally {
    setButtonLoading(button, false, 'Entrar →');
  }
}

async function submitSignup() {
  var fullName = document.getElementById('signupName').value.trim();
  var email = document.getElementById('signupEmail').value.trim();
  var password = document.getElementById('signupPassword').value;
  var confirm = document.getElementById('signupConfirm').value;
  var button = document.getElementById('btnSignup');

  if (!fullName || !email || !password || !confirm) {
    showToast('Preencha todos os campos.');
    return;
  }

  if (password !== confirm) {
    showToast('As senhas não coincidem.');
    return;
  }

  setButtonLoading(button, true, 'Criando conta...');

  try {
    var response = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: fullName,
        email: email,
        password: password
      })
    });
    var payload = await safeReadJson(response);

    if (!response.ok) {
      throw new Error(payload.error || 'Não foi possível criar a conta.');
    }

    document.getElementById('signupPassword').value = '';
    document.getElementById('signupConfirm').value = '';
    await handleAuthenticatedUser(payload.user);
    showToast('Conta criada com sucesso!');
  } catch (error) {
    showToast(error.message || 'Não foi possível criar a conta.');
  } finally {
    setButtonLoading(button, false, 'Criar conta →');
  }
}

async function handleAuthenticatedUser(user) {
  currentUser = user || null;
  syncUserIntoUi();
  applyTheme(currentUser ? currentUser.siteTheme : loadStoredTheme(), { remote: false, silent: true });
  goToChat();
  await loadChats();
}

async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (error) {}

  currentUser = null;
  currentChatId = null;
  currentMessages = [];
  chatHistory = [];
  chatList = [];
  attachedFiles = [];
  removeTyping();
  renderFilePreview();
  renderChatList();
  resetMessageArea();
  clearProfileFields();
  goToLogin();
  applyTheme(loadStoredTheme(), { remote: false, silent: true });
}

function newChat() {
  currentChatId = null;
  currentMessages = [];
  chatHistory = [];
  attachedFiles = [];
  removeTyping();
  renderFilePreview();
  resetMessageArea();
  document.querySelectorAll('.chat-item').forEach(function (el) {
    el.classList.remove('active');
  });
}

function clearChat() {
  if (!currentChatId) {
    if (!currentMessages.length && !attachedFiles.length) return;
    newChat();
    showToast('Rascunho limpo.');
    return;
  }

  deleteCurrentChat(currentChatId);
}

function resetMessageArea() {
  document.getElementById('welcomeState').style.display = '';
  document.getElementById('messageList').style.display = 'none';
  document.getElementById('messageList').innerHTML = '';
}

function filterChats(query) {
  document.querySelectorAll('.chat-item').forEach(function (el) {
    var title = el.dataset.title || '';
    var preview = el.dataset.preview || '';
    var haystack = (title + ' ' + preview).toLowerCase();
    el.style.display = haystack.indexOf(query.toLowerCase()) > -1 ? '' : 'none';
  });
}

async function loadChats(preferredChatId, options) {
  if (!currentUser) return;
  options = options || {};

  try {
    var response = await fetch('/api/chats');
    var payload = await safeReadJson(response);
    if (!response.ok) {
      throw new Error(payload.error || 'Não foi possível carregar os chats.');
    }

    chatList = payload.chats || [];
    renderChatList();

    if (preferredChatId) {
      await loadChat(preferredChatId);
      return;
    }

    if (options.preserveCurrentView) {
      highlightActiveChat();
      return;
    }

    if (currentChatId) {
      var stillExists = chatList.some(function (chat) { return chat.id === currentChatId; });
      if (stillExists) {
        highlightActiveChat();
        return;
      }
    }

    if (chatList.length) {
      await loadChat(chatList[0].id);
    } else {
      newChat();
    }
  } catch (error) {
    showToast(error.message || 'Falha ao carregar chats.');
  }
}

async function deleteCurrentChat(chatId) {
  if (!chatId) return;

  var confirmed = window.confirm('Deseja excluir este chat? Essa conversa sairá da sua lista.');
  if (!confirmed) return;

  try {
    var response = await fetch('/api/chats/' + chatId, {
      method: 'DELETE'
    });
    var payload = await safeReadJson(response);

    if (!response.ok) {
      throw new Error(payload.error || 'Não foi possível excluir o chat.');
    }

    if (currentChatId === chatId) {
      currentChatId = null;
      currentMessages = [];
      chatHistory = [];
      attachedFiles = [];
      renderFilePreview();
      resetMessageArea();
    }

    chatList = chatList.filter(function (chat) {
      return chat.id !== chatId;
    });

    renderChatList();

    if (chatList.length) {
      await loadChat(chatList[0].id);
    } else {
      newChat();
    }

    showToast('Chat excluído.');
  } catch (error) {
    showToast(error.message || 'Falha ao excluir o chat.');
  }
}

function renderChatList() {
  var container = document.getElementById('chatList');

  if (!chatList.length) {
    container.innerHTML =
      '<div class="sidebar-empty">'
      + '<div class="sidebar-empty-icon">💬</div>'
      + '<div class="sidebar-empty-text">Nenhuma conversa ainda.<br>Comece um novo chat.</div>'
      + '</div>';
    return;
  }

  container.innerHTML = chatList.map(function (chat) {
    var active = chat.id === currentChatId ? ' active' : '';
    var preview = escapeHtml(chat.lastMessagePreview || 'Sem mensagens ainda');
    return ''
      + '<button class="chat-item' + active + '"'
      + ' data-chat-id="' + chat.id + '"'
      + ' data-title="' + escapeHtml(chat.title || 'Novo chat') + '"'
      + ' data-preview="' + preview + '"'
      + ' onclick="loadChat(' + chat.id + ')">'
      + '<div class="chat-item-body">'
      + '<span class="chat-item-title">' + escapeHtml(chat.title || 'Novo chat') + '</span>'
      + '<span class="chat-item-preview">' + preview + '</span>'
      + '</div>'
      + '</button>';
  }).join('');
}

function highlightActiveChat() {
  document.querySelectorAll('.chat-item').forEach(function (item) {
    item.classList.toggle('active', Number(item.dataset.chatId) === currentChatId);
  });
}

async function loadChat(chatId) {
  if (!chatId) return;

  try {
    var response = await fetch('/api/chats/' + chatId);
    var payload = await safeReadJson(response);

    if (!response.ok) {
      throw new Error(payload.error || 'Não foi possível abrir o chat.');
    }

    currentChatId = payload.chat.id;
    currentMessages = payload.messages || [];
    syncHistoryFromMessages();
    renderConversation();
    highlightActiveChat();
  } catch (error) {
    showToast(error.message || 'Falha ao abrir a conversa.');
  }
}

function renderConversation() {
  var list = document.getElementById('messageList');
  list.innerHTML = '';

  if (!currentMessages.length) {
    resetMessageArea();
    return;
  }

  document.getElementById('welcomeState').style.display = 'none';
  list.style.display = 'block';

  currentMessages.forEach(function (message) {
    if (message.role === 'user') {
      appendUserMessage({
        text: message.contentText,
        attachments: message.attachments || [],
        animate: false
      });
      return;
    }

    if (message.role === 'assistant') {
      appendAssistantMessage({
        text: message.contentText,
        sources: message.sources || [],
        unsupported: (message.metadata && message.metadata.unsupported) || [],
        fileIssues: (message.metadata && message.metadata.fileIssues) || [],
        animate: false,
        messageId: message.id,
        feedbackValue: message.feedbackValue || null
      });
    }
  });

  scrollMessageList();
}

function syncHistoryFromMessages() {
  chatHistory = currentMessages
    .filter(function (message) {
      return message.role === 'user' || message.role === 'assistant';
    })
    .map(function (message) {
      return {
        role: message.role,
        content: message.contentText || ''
      };
    })
    .filter(function (message) {
      return message.content.trim();
    });
}

function isRequestConversationVisible(requestState) {
  return !!requestState && currentMessages === requestState.messages;
}

function getChatSortTimestamp(chat) {
  var value = chat && (chat.updatedAt || chat.lastMessageAt || chat.createdAt);
  var time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function upsertChatSummary(chat) {
  if (!chat || !chat.id) return;

  var nextChat = Object.assign({}, chat);
  var existingIndex = chatList.findIndex(function (item) {
    return item.id === nextChat.id;
  });

  if (existingIndex > -1) {
    chatList[existingIndex] = Object.assign({}, chatList[existingIndex], nextChat);
  } else {
    chatList.push(nextChat);
  }

  chatList.sort(function (left, right) {
    return getChatSortTimestamp(right) - getChatSortTimestamp(left)
      || Number(right.id || 0) - Number(left.id || 0);
  });

  renderChatList();
  highlightActiveChat();
}

function buildPendingChatPreview(text, files) {
  var normalizedText = String(text || '').trim();
  if (normalizedText) {
    return normalizedText.slice(0, 160);
  }

  if (files && files.length) {
    return '(mensagem com anexo)';
  }

  return 'Sem mensagens ainda';
}

async function createChatForRequest(question, filesToSend, requestState) {
  var response = await fetch('/api/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: question || '',
      attachmentNames: (filesToSend || [])
        .map(function (file) { return file && file.name ? file.name : ''; })
        .filter(Boolean)
    })
  });
  var payload = await safeReadJson(response);

  if (!response.ok) {
    throw new Error(payload.error || 'Não foi possível criar o chat.');
  }

  var chat = Object.assign({}, payload.chat || {}, {
    lastMessagePreview: buildPendingChatPreview(question, filesToSend),
    updatedAt: (payload.chat && payload.chat.updatedAt) || new Date().toISOString()
  });

  requestState.chatId = chat.id;

  if (isRequestConversationVisible(requestState)) {
    currentChatId = chat.id;
  }

  upsertChatSummary(chat);
  return chat;
}

function syncRequestMeta(requestState, payload) {
  if (!requestState || !payload) return;

  if (payload.chatId) {
    requestState.chatId = payload.chatId;
  }

  if (payload.userMessageId) {
    requestState.localUserMessage.id = payload.userMessageId;
  }

  if (!requestState.chatId) return;

  if (isRequestConversationVisible(requestState)) {
    currentChatId = requestState.chatId;
    highlightActiveChat();
  }

  loadChats(null, { preserveCurrentView: true }).catch(function (error) {
    console.error(error);
  });
}

function ensureAssistantElementForRequest(requestState, data) {
  if (!isRequestConversationVisible(requestState)) return null;

  if (!requestState.aiEl) {
    removeTyping();
    requestState.aiEl = appendAssistantMessage({
      text: '',
      sources: (data && data.sources) || [],
      unsupported: (data && data.unsupported) || [],
      fileIssues: (data && data.fileIssues) || [],
      animate: false,
      messageId: null,
      feedbackValue: null
    });
  }

  return requestState.aiEl;
}

function appendRequestErrorMessage(requestState, message, data) {
  if (!isRequestConversationVisible(requestState)) return;

  appendAssistantMessage({
    text: message,
    sources: (data && data.sources) || [],
    unsupported: (data && data.unsupported) || [],
    fileIssues: (data && data.fileIssues) || [],
    animate: true,
    messageId: null,
    feedbackValue: null
  });
}

async function sendMessage() {
  var input = document.getElementById('chatInput');
  var rawText = input.value;
  var text = rawText.trim();

  if (!text && attachedFiles.length === 0) return;
  if (isTyping) return;

  document.getElementById('welcomeState').style.display = 'none';
  document.getElementById('messageList').style.display = 'block';

  var filesToSend = attachedFiles.slice();
  var totalBytes = filesToSend.reduce(function (sum, file) {
    return sum + Number(file && file.size ? file.size : 0);
  }, 0);

  if (filesToSend.length > MAX_ATTACHMENT_FILES) {
    showToast('Envie no máximo ' + MAX_ATTACHMENT_FILES + ' arquivos por vez.');
    return;
  }

  if (filesToSend.some(function (file) { return Number(file && file.size ? file.size : 0) > MAX_ATTACHMENT_FILE_BYTES; })) {
    showToast('Cada arquivo deve ter no máximo ' + formatByteSize(MAX_ATTACHMENT_FILE_BYTES) + '.');
    return;
  }

  if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
    showToast('O total de anexos por envio deve ficar em até ' + formatByteSize(MAX_ATTACHMENT_TOTAL_BYTES) + '.');
    return;
  }

  var localUserMessage = {
    id: null,
    role: 'user',
    contentText: text,
    attachments: serializeLocalFiles(filesToSend),
    metadata: { hasAttachments: filesToSend.length > 0 }
  };

  currentMessages.push(localUserMessage);
  syncHistoryFromMessages();
  appendUserMessage({ text: text, attachments: filesToSend, animate: true });

  input.value = '';
  input.style.height = 'auto';
  attachedFiles = [];
  renderFilePreview();
  showTyping();

  var requestState = {
    messages: currentMessages,
    localUserMessage: localUserMessage,
    chatId: currentChatId,
    aiEl: null,
    answer: '',
    meta: null
  };

  try {
    if (!requestState.chatId) {
      await createChatForRequest(text, filesToSend, requestState);
    }

    var fetchOptions;

    if (filesToSend.length > 0 && ATTACHMENT_UPLOAD_MODE !== 'blob_direct') {
      var form = new FormData();
      form.append('question', text || '');
      if (requestState.chatId) form.append('chatId', String(requestState.chatId));
      form.append('history', JSON.stringify(chatHistory.slice(-10)));
      filesToSend.forEach(function (file) { form.append('files', file); });
      fetchOptions = {
        method: 'POST',
        headers: {
          Accept: 'application/x-ndjson',
          'X-Response-Mode': 'stream'
        },
        body: form
      };
    } else {
      var uploadedAttachments = [];

      if (filesToSend.length > 0 && ATTACHMENT_UPLOAD_MODE === 'blob_direct') {
        uploadedAttachments = await uploadAttachmentFilesDirect(filesToSend, requestState.chatId);
      }

      fetchOptions = {
        method: 'POST',
        headers: {
          Accept: 'application/x-ndjson',
          'Content-Type': 'application/json',
          'X-Response-Mode': 'stream'
        },
        body: JSON.stringify({
          question: text,
          chatId: requestState.chatId,
          history: chatHistory.slice(-10),
          attachments: uploadedAttachments
        })
      };
    }

    var response = await fetch('/api/ask', fetchOptions);

    if (!response.ok) {
      var errorPayload = await safeReadJson(response);
      var requestError = new Error(errorPayload.error || 'Erro ao processar a pergunta.');
      requestError.payload = errorPayload;
      throw requestError;
    }

    var contentType = response.headers.get('content-type') || '';
    var data;

    if (contentType.indexOf('application/x-ndjson') > -1 && response.body) {
      data = await consumeAssistantStream(response, requestState);
    } else {
      data = await response.json();
      syncRequestMeta(requestState, data);
      var assistantNode = ensureAssistantElementForRequest(requestState, data);
      if (assistantNode) {
        renderFinalAssistantMessage(assistantNode, data.answer || '', data);
      }
    }

    if (data.error) {
      return;
    }

    syncRequestMeta(requestState, data);

    var assistantMessage = {
      id: data.assistantMessageId || null,
      role: 'assistant',
      contentText: data.answer || '',
      sources: data.sources || [],
      metadata: {
        unsupported: data.unsupported || [],
        fileIssues: data.fileIssues || []
      },
      feedbackValue: null
    };

    requestState.messages.push(assistantMessage);

    if (isRequestConversationVisible(requestState)) {
      syncHistoryFromMessages();
      await loadChats(requestState.chatId || currentChatId);
    } else {
      await loadChats(null, { preserveCurrentView: true });
    }
  } catch (error) {
    var errorPayload = error && error.payload ? error.payload : null;
    if (errorPayload) {
      syncRequestMeta(requestState, errorPayload);
    }

    var errorText = '⚠️ ' + ((errorPayload && errorPayload.error) || error.message || 'Erro de conexão.');
    if (isRequestConversationVisible(requestState)) {
      appendRequestErrorMessage(requestState, errorText, errorPayload);
    } else {
      showToast((errorPayload && errorPayload.error) || error.message || 'Erro de conexão.');
    }

    console.error(error);
  } finally {
    removeTyping();
  }
}

async function consumeAssistantStream(response, requestState) {
  var reader = response.body.getReader();
  var decoder = new TextDecoder();
  var buffer = '';

  while (true) {
    var result = await reader.read();
    if (result.done) break;

    buffer += decoder.decode(result.value, { stream: true });
    var lines = buffer.split('\n');
    buffer = lines.pop();

    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i].trim();
      if (!line) continue;

      var event = JSON.parse(line);
      var handled = handleStreamEvent(event, requestState);
      if (handled.done) return handled.data;
    }
  }

  if (buffer.trim()) {
    var finalEvent = JSON.parse(buffer.trim());
    var finalHandled = handleStreamEvent(finalEvent, requestState);
    if (finalHandled.done) return finalHandled.data;
  }

  var fallbackData = Object.assign({}, requestState.meta || {});
  fallbackData.answer = requestState.answer;
  var fallbackAiEl = ensureAssistantElementForRequest(requestState, fallbackData);
  if (fallbackAiEl) {
    renderFinalAssistantMessage(fallbackAiEl, requestState.answer, fallbackData);
  }
  return fallbackData;
}

function handleStreamEvent(event, requestState) {
  if (event.type === 'meta') {
    requestState.meta = Object.assign({}, requestState.meta || {}, event.data || {});
    syncRequestMeta(requestState, requestState.meta);
  }

  if (event.type === 'chunk') {
    requestState.answer += event.delta || '';
    var chunkAiEl = ensureAssistantElementForRequest(requestState, requestState.meta || {});
    if (chunkAiEl) {
      renderStreamingAssistantMessage(chunkAiEl, requestState.answer);
    }
  }

  if (event.type === 'done') {
    var data = Object.assign({}, requestState.meta || {}, event.data || {});
    requestState.meta = data;
    syncRequestMeta(requestState, data);
    requestState.answer = data.answer || requestState.answer;
    var doneAiEl = ensureAssistantElementForRequest(requestState, data);
    if (doneAiEl) {
      renderFinalAssistantMessage(doneAiEl, requestState.answer, data);
    }
    return { done: true, data: data };
  }

  if (event.type === 'error') {
    var errorData = Object.assign({}, requestState.meta || {}, event.data || {});
    syncRequestMeta(requestState, errorData);
    var errorText = requestState.answer
      ? requestState.answer + '\n\n⚠️ ' + (event.error || 'Erro ao processar a resposta.')
      : '⚠️ ' + (event.error || 'Erro ao processar a resposta.');
    var errorAiEl = ensureAssistantElementForRequest(requestState, errorData);
    if (errorAiEl) {
      renderFinalAssistantMessage(errorAiEl, errorText, errorData);
    }
    return {
      done: true,
      data: Object.assign({}, errorData, {
        error: event.error || 'Erro ao processar a resposta.',
        answer: requestState.answer
      })
    };
  }

  return { done: false };
}

function safeReadJson(response) {
  return response.json().catch(function () {
    return {};
  });
}

function getSourceKind(source) {
  if (!source) return 'notion';
  if (source.sourceType === 'web_url') return 'web';
  if (source.metadata && source.metadata.kind === 'web') return 'web';
  return 'notion';
}

function renderSourceList(label, sources) {
  if (!sources || sources.length === 0) return '';

  return '<div class="msg-sources">'
    + '<div class="msg-sources-label">' + escapeHtml(label) + '</div>'
    + sources.map(function (source) {
      var url = source.url ? ' href="' + source.url + '" target="_blank" rel="noopener"' : '';
      return '<a class="msg-source-link"' + url + '>'
        + escapeHtml(source.title || 'Fonte') + '</a>';
    }).join('')
    + '</div>';
}

function buildAssistantExtrasHtml(data) {
  var html = '';

  if (data.sources && data.sources.length > 0) {
    var notionSources = data.sources.filter(function (source) {
      return getSourceKind(source) !== 'web';
    });
    var webSources = data.sources.filter(function (source) {
      return getSourceKind(source) === 'web';
    });

    html += renderSourceList('Fontes internas (Notion):', notionSources);
    html += renderSourceList('Fontes da Web:', webSources);
  }

  if (data.unsupported && data.unsupported.length > 0) {
    html += '<div class="msg-sources">'
      + '<div class="msg-sources-label" style="color:var(--danger);">Tipo não suportado:</div>'
      + data.unsupported.map(function (name) {
        return '<span class="msg-source-link" style="opacity:.7;">⚠️ ' + escapeHtml(name) + '</span>';
      }).join('')
      + '</div>';
  }

  if (data.fileIssues && data.fileIssues.length > 0) {
    html += '<div class="msg-sources">'
      + '<div class="msg-sources-label" style="color:var(--danger);">Falha ao ler arquivos:</div>'
      + data.fileIssues.map(function (item) {
        return '<span class="msg-source-link" style="opacity:.7;">⚠️ '
          + escapeHtml(item.name || 'Arquivo') + ' - ' + escapeHtml(item.reason || 'Falha de leitura') + '</span>';
      }).join('')
      + '</div>';
  }

  return html;
}

function buildUserMessageHtml(text, files) {
  var html = '';

  if (files && files.length > 0) {
    html += '<div class="user-attachment-list">'
      + files.map(function (file) {
        var name = escapeHtml(file.displayName || file.name || 'arquivo');
        if (file.downloadUrl) {
          return '<a class="user-attachment-item user-attachment-link" href="' + file.downloadUrl + '" target="_blank" rel="noopener">'
            + '<span class="user-attachment-icon">📎</span>'
            + '<span class="user-attachment-name">' + name + '</span>'
            + '</a>';
        }

        return '<div class="user-attachment-item">'
          + '<span class="user-attachment-icon">📎</span>'
          + '<span class="user-attachment-name">' + name + '</span>'
          + '</div>';
      }).join('')
      + '</div>';
  }

  if (text) {
    html += '<div class="user-message-text">' + escapeHtml(text).replace(/\n/g, '<br>') + '</div>';
  }

  if (!html) {
    html = '<div class="user-message-text">(arquivo anexado)</div>';
  }

  return html;
}

function renderStreamingAssistantMessage(messageEl, answer) {
  var bubble = messageEl.querySelector('.msg-bubble');
  bubble.innerHTML =
    '<p style="margin:0;white-space:pre-wrap;">'
    + escapeHtml(answer || '')
    + '<span style="display:inline-block;margin-left:2px;opacity:.65;">▋</span>'
    + '</p>';
  scrollMessageList();
}

function renderFinalAssistantMessage(messageEl, answer, data) {
  var bubble = messageEl.querySelector('.msg-bubble');
  var actions = messageEl.querySelector('.msg-actions');
  var messageId = data.assistantMessageId || Number(messageEl.getAttribute('data-message-id')) || null;
  var feedbackValue = data.feedbackValue || null;

  if (messageId) {
    messageEl.setAttribute('data-message-id', messageId);
  }

  bubble.innerHTML = formatResponse(answer || '') + buildAssistantExtrasHtml(data || {});

  if (actions) {
    actions.innerHTML = buildAssistantActionsHtml(messageId, feedbackValue);
  }

  scrollMessageList();
}

function formatResponse(text) {
  if (!text) {
    return '<div class="ai-markdown"><p></p></div>';
  }

  var source = normalizeAssistantMarkdownForDisplay(String(text).replace(/\r\n/g, '\n').trim());
  var lines = source.split('\n');
  var blocks = [];
  var paragraphLines = [];
  var listType = null;
  var listItems = [];
  var inCodeBlock = false;
  var codeLines = [];

  function flushParagraph() {
    if (!paragraphLines.length) return;
    blocks.push('<p>' + formatInlineMarkdown(paragraphLines.join(' ')) + '</p>');
    paragraphLines = [];
  }

  function flushList() {
    if (!listItems.length || !listType) return;

    blocks.push(
      '<' + listType + '>'
      + listItems.map(function (item) {
        return '<li>' + formatInlineMarkdown(item) + '</li>';
      }).join('')
      + '</' + listType + '>'
    );

    listItems = [];
    listType = null;
  }

  function flushCodeBlock() {
    if (!codeLines.length) return;
    blocks.push('<pre><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre>');
    codeLines = [];
  }

  lines.forEach(function (line) {
    var trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      flushParagraph();
      flushList();

      if (inCodeBlock) {
        flushCodeBlock();
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }

      return;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      return;
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      return;
    }

    var headingMatch = /^(#{2,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      var headingLevel = Math.min(3, headingMatch[1].length);
      flushParagraph();
      flushList();
      blocks.push('<h' + headingLevel + '>' + formatInlineMarkdown(headingMatch[2]) + '</h' + headingLevel + '>');
      return;
    }

    var orderedMatch = /^(\d+)\.\s+(.+)$/.exec(trimmed);
    if (orderedMatch) {
      flushParagraph();
      if (listType && listType !== 'ol') flushList();
      listType = 'ol';
      listItems.push(orderedMatch[2]);
      return;
    }

    var bulletMatch = /^[-*]\s+(.+)$/.exec(trimmed);
    if (bulletMatch) {
      flushParagraph();
      if (listType && listType !== 'ul') flushList();
      listType = 'ul';
      listItems.push(bulletMatch[1]);
      return;
    }

    flushList();
    paragraphLines.push(trimmed);
  });

  if (inCodeBlock) flushCodeBlock();
  flushParagraph();
  flushList();

  if (!blocks.length) {
    return '<div class="ai-markdown"><p>' + formatInlineMarkdown(source) + '</p></div>';
  }

  return '<div class="ai-markdown">' + blocks.join('') + '</div>';
}

function normalizeAssistantMarkdownForDisplay(text) {
  return String(text || '')
    .replace(/^(#{4,})\s+/gm, '## ')
    .replace(/(^\d+\.\s[^\n]+)\n{2,}(?=\d+\.\s)/gm, '$1\n')
    .replace(/(^[-*]\s[^\n]+)\n{2,}(?=[-*]\s)/gm, '$1\n');
}

function formatInlineMarkdown(text) {
  var placeholders = [];
  var formatted = escapeHtml(text || '');

  formatted = formatted.replace(/`([^`\n]+)`/g, function (_, value) {
    var key = '%%INLINE_CODE_' + placeholders.length + '%%';
    placeholders.push('<code>' + value + '</code>');
    return key;
  });

  formatted = formatted.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  formatted = formatted.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  placeholders.forEach(function (value, index) {
    formatted = formatted.replace('%%INLINE_CODE_' + index + '%%', value);
  });

  return formatted;
}

function appendUserMessage(options) {
  return appendMessage('user', buildUserMessageHtml(options.text, options.attachments), options.animate !== false, {});
}

function appendAssistantMessage(options) {
  var element = appendMessage('assistant', '', options.animate !== false, {
    messageId: options.messageId,
    feedbackValue: options.feedbackValue
  });
  renderFinalAssistantMessage(element, options.text || '', {
    sources: options.sources || [],
    unsupported: options.unsupported || [],
    fileIssues: options.fileIssues || [],
    assistantMessageId: options.messageId || null,
    feedbackValue: options.feedbackValue || null
  });
  return element;
}

function appendMessage(role, html, animate, options) {
  if (animate === undefined) animate = true;
  options = options || {};

  var list = document.getElementById('messageList');
  var isUser = role === 'user';
  var div = document.createElement('div');
  var messageId = options.messageId || null;

  div.className = 'message' + (isUser ? ' user-msg' : '');
  if (animate) div.style.animation = 'msgIn 0.3s ease both';
  if (messageId) div.setAttribute('data-message-id', messageId);

  div.innerHTML =
    '<div class="msg-avatar ' + (isUser ? 'user' : 'ai') + '">' + (isUser ? getUserAvatarHtml() : getAiAvatarHtml()) + '</div>'
    + '<div class="msg-content">'
    + '<div class="msg-name">' + (isUser ? 'Você' : 'SmartAI') + (!isUser ? ' <span class="badge">AI</span>' : '') + '</div>'
    + '<div class="msg-bubble' + (isUser ? ' user-bubble' : '') + '">' + html + '</div>'
    + (!isUser ? '<div class="msg-actions">' + buildAssistantActionsHtml(messageId, options.feedbackValue) + '</div>' : '')
    + '</div>';

  list.appendChild(div);
  scrollMessageList();
  return div;
}

function buildAssistantActionsHtml(messageId, feedbackValue) {
  if (!messageId) {
    return '<button class="msg-action-btn" onclick="copyMsg(this)">Copiar</button>';
  }

  return ''
    + '<button class="msg-action-btn" onclick="copyMsg(this)">'
    + '<svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">'
    + '<rect x="9" y="9" width="13" height="13" rx="2"/>'
    + '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'
    + '</svg> Copiar</button>'
    + '<button class="msg-action-btn' + (feedbackValue === 'useful' ? ' active' : '') + '" onclick="sendQuickFeedback(' + messageId + ', \'useful\', this)">'
    + '<svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">'
    + '<path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/>'
    + '<path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>'
    + '</svg> Útil</button>'
    + '<button class="msg-action-btn' + (feedbackValue === 'not_useful' ? ' active' : '') + '" onclick="openFeedbackPrompt(' + messageId + ')">'
    + '<svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">'
    + '<path d="M10 14H5.24A2.24 2.24 0 0 1 3 11.76V5.24A2.24 2.24 0 0 1 5.24 3h6.52A2.24 2.24 0 0 1 14 5.24V10"/>'
    + '<path d="M14 21l7-7-3-3-7 7-1 4z"/>'
    + '</svg> Corrigir</button>';
}

function getUserAvatarHtml() {
  var initials = getUserInitials(currentUser && currentUser.fullName ? currentUser.fullName : 'Usuário');
  if (currentUser && currentUser.profilePhotoUrl) {
    return '<img src="' + currentUser.profilePhotoUrl + '" alt="Usuário" class="avatar-photo">';
  }
  return '<span>' + escapeHtml(initials) + '</span>';
}

function getUserInitials(name) {
  return String(name || 'U')
    .split(' ')
    .filter(Boolean)
    .map(function (part) { return part[0]; })
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'U';
}

function copyMsg(btn) {
  var bubble = btn.closest('.msg-content').querySelector('.msg-bubble');
  navigator.clipboard.writeText(bubble.textContent).catch(function () {});
  showToast('Copiado!');
}

async function sendQuickFeedback(messageId, feedbackValue, buttonEl) {
  try {
    var response = await fetch('/api/messages/' + messageId + '/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedbackValue: feedbackValue })
    });
    var payload = await safeReadJson(response);

    if (!response.ok) {
      throw new Error(payload.error || 'Não foi possível salvar o feedback.');
    }

    setMessageFeedback(messageId, feedbackValue);
    updateFeedbackButtons(messageId, feedbackValue);
    showToast(feedbackValue === 'useful' ? 'Feedback salvo!' : 'Feedback registrado!');
  } catch (error) {
    showToast(error.message || 'Falha ao salvar o feedback.');
  }
}

async function openFeedbackPrompt(messageId) {
  var comment = window.prompt('O que ficou errado, incompleto ou confuso nessa resposta?');
  if (comment === null) return;

  var suggestedCorrection = window.prompt('Se quiser, descreva a correção esperada:') || '';

  try {
    var response = await fetch('/api/messages/' + messageId + '/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feedbackValue: 'not_useful',
        comment: comment,
        suggestedCorrection: suggestedCorrection,
        issueType: 'other',
        title: 'Correção sugerida por usuário'
      })
    });
    var payload = await safeReadJson(response);

    if (!response.ok) {
      throw new Error(payload.error || 'Não foi possível salvar a correção.');
    }

    setMessageFeedback(messageId, 'not_useful');
    updateFeedbackButtons(messageId, 'not_useful');
    showToast(payload.queueItemId ? 'Feedback enviado para revisão.' : 'Feedback salvo.');
  } catch (error) {
    showToast(error.message || 'Falha ao salvar o feedback.');
  }
}

function setMessageFeedback(messageId, feedbackValue) {
  currentMessages.forEach(function (message) {
    if (message.id === messageId) {
      message.feedbackValue = feedbackValue;
    }
  });
}

function updateFeedbackButtons(messageId, feedbackValue) {
  var messageEl = document.querySelector('.message[data-message-id="' + messageId + '"]');
  if (!messageEl) return;

  var actions = messageEl.querySelector('.msg-actions');
  if (!actions) return;

  actions.innerHTML = buildAssistantActionsHtml(messageId, feedbackValue);
}

function showTyping() {
  isTyping = true;
  var list = document.getElementById('messageList');
  typingEl = document.createElement('div');
  typingEl.className = 'message';
  typingEl.id = 'typingMsg';
  typingEl.innerHTML =
    '<div class="msg-avatar ai">' + getAiAvatarHtml() + '</div>'
    + '<div class="msg-content">'
    + '<div class="msg-name">SmartAI <span class="badge">AI</span></div>'
    + '<div class="typing-indicator">'
    + '<div class="typing-dot"></div>'
    + '<div class="typing-dot"></div>'
    + '<div class="typing-dot"></div>'
    + '</div>'
    + '</div>';
  list.appendChild(typingEl);
  scrollMessageList();
}

function removeTyping() {
  isTyping = false;
  var el = document.getElementById('typingMsg');
  if (el) el.remove();
}

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

function handleFileAttach(e) {
  addAttachedFiles(e.target.files);
  e.target.value = '';
}

function addAttachedFiles(fileList) {
  var files = Array.from(fileList || []).filter(Boolean);
  if (!files.length) return;

  if (files.some(function (file) { return Number(file && file.size ? file.size : 0) > MAX_ATTACHMENT_FILE_BYTES; })) {
    showToast('Cada arquivo deve ter no máximo ' + formatByteSize(MAX_ATTACHMENT_FILE_BYTES) + '.');
    return;
  }

  var nextFiles = attachedFiles.concat(files);
  if (nextFiles.length > MAX_ATTACHMENT_FILES) {
    showToast('Envie no máximo ' + MAX_ATTACHMENT_FILES + ' arquivos por vez.');
    return;
  }

  var totalBytes = nextFiles.reduce(function (sum, file) {
    return sum + Number(file && file.size ? file.size : 0);
  }, 0);
  if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
    showToast('O total de anexos por envio deve ficar em até ' + formatByteSize(MAX_ATTACHMENT_TOTAL_BYTES) + '.');
    return;
  }

  attachedFiles = nextFiles;
  renderFilePreview();
}

function renderFilePreview() {
  var area = document.getElementById('filePreview');
  area.innerHTML = '';

  attachedFiles.forEach(function (file, index) {
    var chip = document.createElement('div');
    chip.className = 'file-chip';
    chip.innerHTML =
      '<span>📎 ' + escapeHtml(file.name) + '</span>'
      + '<span class="file-chip-remove" onclick="removeFile(' + index + ')">✕</span>';
    area.appendChild(chip);
  });

  area.classList.toggle('visible', attachedFiles.length > 0);
}

function removeFile(index) {
  attachedFiles.splice(index, 1);
  renderFilePreview();
}

function initDragAndDrop() {
  var composer = document.getElementById('composerBox');
  if (!composer) return;

  composer.addEventListener('dragenter', handleComposerDrag);
  composer.addEventListener('dragover', handleComposerDrag);
  composer.addEventListener('dragleave', function (e) {
    if (composer.contains(e.relatedTarget)) return;
    composer.classList.remove('drag-active');
  });
  composer.addEventListener('drop', function (e) {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    composer.classList.remove('drag-active');
    addAttachedFiles(e.dataTransfer.files);
  });

  document.addEventListener('dragover', function (e) {
    if (hasDraggedFiles(e)) e.preventDefault();
  });
  document.addEventListener('drop', function (e) {
    if (hasDraggedFiles(e)) e.preventDefault();
  });
}

function handleComposerDrag(e) {
  if (!hasDraggedFiles(e)) return;
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('composerBox').classList.add('drag-active');
}

function hasDraggedFiles(e) {
  if (!e.dataTransfer || !e.dataTransfer.types) return false;
  return Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') > -1;
}

function openThemes() {
  document.getElementById('themePanel').classList.add('open');
}

function openProfile() {
  document.getElementById('profilePanel').classList.add('open');
}

function closePanel(id) {
  document.getElementById(id).classList.remove('open');
}

function closePanelOnOverlay(e, id) {
  if (e.target === e.currentTarget) closePanel(id);
}

async function applyTheme(name, options) {
  options = options || {};
  var normalized = normalizeTheme(name);

  document.body.className = normalized === 'default' ? '' : 'theme-' + normalized;
  document.querySelectorAll('.theme-option').forEach(function (opt) {
    opt.classList.toggle('selected', opt.id === 'theme-' + (normalized === 'default' ? 'default' : normalized));
  });

  try {
    localStorage.setItem('nexus-theme', normalized);
  } catch (error) {}

  if (!options.silent) {
    var labels = {
      default: 'Padrão',
      midnight: 'Meia-noite',
      ocean: 'Oceano',
      forest: 'Floresta',
      rose: 'Rosa',
      light: 'Claro'
    };
    showToast('Tema: ' + labels[normalized]);
  }

  if (currentUser) {
    currentUser.siteTheme = normalized;
  }

  if (currentUser && options.remote !== false) {
    try {
      var response = await fetch('/api/profile/theme', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: normalized })
      });
      var payload = await safeReadJson(response);
      if (!response.ok) {
        throw new Error(payload.error || 'Não foi possível salvar o tema.');
      }
      currentUser = payload.user;
      syncUserIntoUi();
    } catch (error) {
      showToast(error.message || 'Falha ao salvar o tema.');
    }
  }
}

async function saveName() {
  var input = document.getElementById('inputNewName');
  var fullName = input.value.trim();
  var button = document.getElementById('btnSaveName');

  if (!fullName) {
    showToast('Informe um nome válido.');
    return;
  }

  setButtonLoading(button, true, 'Salvando...');

  try {
    var response = await fetch('/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName: fullName })
    });
    var payload = await safeReadJson(response);

    if (!response.ok) {
      throw new Error(payload.error || 'Não foi possível atualizar o nome.');
    }

    currentUser = payload.user;
    syncUserIntoUi();
    input.value = '';
    showToast('Nome atualizado!');
  } catch (error) {
    showToast(error.message || 'Falha ao atualizar o nome.');
  } finally {
    setButtonLoading(button, false, 'Salvar nome');
  }
}

async function savePassword() {
  var currentPassword = document.getElementById('inputCurrentPassword').value;
  var newPassword = document.getElementById('inputNewPassword').value;
  var confirmPassword = document.getElementById('inputConfirmPassword').value;
  var button = document.getElementById('btnSavePassword');

  if (!currentPassword || !newPassword || !confirmPassword) {
    showToast('Preencha todos os campos de senha.');
    return;
  }

  if (newPassword !== confirmPassword) {
    showToast('A confirmação da nova senha não confere.');
    return;
  }

  setButtonLoading(button, true, 'Atualizando...');

  try {
    var response = await fetch('/api/profile/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword: currentPassword,
        newPassword: newPassword
      })
    });
    var payload = await safeReadJson(response);

    if (!response.ok) {
      throw new Error(payload.error || 'Não foi possível atualizar a senha.');
    }

    document.getElementById('inputCurrentPassword').value = '';
    document.getElementById('inputNewPassword').value = '';
    document.getElementById('inputConfirmPassword').value = '';
    showToast('Senha atualizada!');
  } catch (error) {
    showToast(error.message || 'Falha ao atualizar a senha.');
  } finally {
    setButtonLoading(button, false, 'Atualizar senha');
  }
}

async function handleProfilePhoto(e) {
  var file = e.target.files && e.target.files[0];
  var button = document.getElementById('btnUploadPhoto');

  if (!file) return;
  if (file.size > MAX_PROFILE_PHOTO_BYTES) {
    e.target.value = '';
    showToast('A foto de perfil deve ter no máximo ' + formatByteSize(MAX_PROFILE_PHOTO_BYTES) + '.');
    return;
  }

  var form = new FormData();
  form.append('photo', file);
  setButtonLoading(button, true, 'Enviando...');

  try {
    var response = await fetch('/api/profile/photo', {
      method: 'POST',
      body: form
    });
    var payload = await safeReadJson(response);

    if (!response.ok) {
      throw new Error(payload.error || 'Não foi possível atualizar a foto.');
    }

    currentUser = payload.user;
    syncUserIntoUi();
    showToast('Foto de perfil atualizada!');
  } catch (error) {
    showToast(error.message || 'Falha ao enviar a foto.');
  } finally {
    e.target.value = '';
    setButtonLoading(button, false, 'Enviar foto');
  }
}

function syncUserIntoUi() {
  var user = currentUser || {
    fullName: 'Usuário',
    email: '—',
    role: 'member',
    profilePhotoUrl: ''
  };

  document.getElementById('sidebarUserName').textContent = user.fullName || 'Usuário';
  document.getElementById('profileNameDisplay').textContent = user.fullName || 'Usuário';
  document.getElementById('profileEmailDisplay').textContent = user.email || '—';
  document.getElementById('sidebarUserRole').textContent = formatRoleLabel(user.role || 'member');
  renderAvatarElement(document.getElementById('sidebarAvatar'), user, 'avatar-photo');
  renderAvatarElement(document.getElementById('bigAvatar'), user, 'avatar-photo');
}

function renderAvatarElement(element, user) {
  if (!element) return;

  if (user.profilePhotoUrl) {
    element.innerHTML = '<img src="' + user.profilePhotoUrl + '" alt="' + escapeHtml(user.fullName || 'Usuário') + '" class="avatar-photo">';
    return;
  }

  element.textContent = getUserInitials(user.fullName || 'Usuário');
}

function formatRoleLabel(role) {
  if (role === 'admin') return 'Administrador';
  if (role === 'reviewer') return 'Revisor interno';
  return 'Membro interno';
}

function clearProfileFields() {
  document.getElementById('profileNameDisplay').textContent = 'Usuário';
  document.getElementById('profileEmailDisplay').textContent = '—';
  document.getElementById('sidebarUserName').textContent = 'Usuário';
  document.getElementById('sidebarUserRole').textContent = 'Membro interno';
  document.getElementById('sidebarAvatar').textContent = '?';
  document.getElementById('bigAvatar').textContent = '?';
  document.getElementById('inputNewName').value = '';
  document.getElementById('inputCurrentPassword').value = '';
  document.getElementById('inputNewPassword').value = '';
  document.getElementById('inputConfirmPassword').value = '';
}

function normalizeTheme(name) {
  var value = String(name || '').trim();
  return value && value !== 'default' ? value : 'default';
}

function loadStoredTheme() {
  try {
    return normalizeTheme(localStorage.getItem('nexus-theme'));
  } catch (error) {
    return 'default';
  }
}

function scrollMessageList() {
  var list = document.getElementById('messageList');
  if (!list || !list.parentElement) return;
  list.parentElement.scrollTop = list.parentElement.scrollHeight;
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function serializeLocalFiles(files) {
  return (files || []).map(function (file) {
    return {
      displayName: file.name,
      name: file.name
    };
  });
}

function setButtonLoading(button, isLoading, label) {
  if (!button) return;
  button.disabled = !!isLoading;

  if (isLoading) {
    if (!button.dataset.originalHtml) {
      button.dataset.originalHtml = button.innerHTML;
    }
    if (label) {
      button.innerHTML = escapeHtml(label);
    }
    return;
  }

  if (button.dataset.originalHtml) {
    button.innerHTML = button.dataset.originalHtml;
    delete button.dataset.originalHtml;
  }
}

function showToast(message) {
  clearTimeout(toastTimer);
  var toast = document.getElementById('toast');
  document.getElementById('toastMsg').textContent = message;
  toast.classList.add('visible');
  toastTimer = setTimeout(function () {
    toast.classList.remove('visible');
  }, 2500);
}

function bindAuthShortcuts() {
  [
    'loginEmail',
    'loginPassword'
  ].forEach(function (id) {
    var element = document.getElementById(id);
    if (!element) return;
    element.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitLogin();
      }
    });
  });

  [
    'signupName',
    'signupEmail',
    'signupPassword',
    'signupConfirm'
  ].forEach(function (id) {
    var element = document.getElementById(id);
    if (!element) return;
    element.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitSignup();
      }
    });
  });
}

function handleAuthResultQuery() {
  try {
    var url = new URL(window.location.href);
    var authSuccess = url.searchParams.get('auth_success');
    var authError = url.searchParams.get('auth_error');

    if (authSuccess === 'google') {
      showToast('Login com Google realizado!');
    }

    if (authError) {
      var messages = {
        google_nao_configurado: 'Login com Google ainda não foi configurado no servidor.',
        google_state_invalido: 'A validação do login com Google expirou. Tente novamente.',
        google_cancelado: 'O login com Google foi cancelado.',
        google_sem_codigo: 'O Google não retornou o código de autenticação.',
        google_falhou: 'Não foi possível concluir o login com Google.'
      };
      showToast(messages[authError] || 'Falha ao autenticar com Google.');
    }

    if (authSuccess || authError) {
      url.searchParams.delete('auth_success');
      url.searchParams.delete('auth_error');
      window.history.replaceState({}, document.title, url.pathname + (url.search || '') + url.hash);
    }
  } catch (error) {}
}

(async function init() {
  applyTheme(loadStoredTheme(), { remote: false, silent: true });
  updateInputHint();
  initDragAndDrop();
  bindAuthShortcuts();
  handleAuthResultQuery();
  await loadClientConfig();

  try {
    var response = await fetch('/api/auth/me');
    var payload = await safeReadJson(response);

    if (response.ok && payload.user) {
      await handleAuthenticatedUser(payload.user);
      return;
    }
  } catch (error) {}

  clearProfileFields();
  goToLogin();
})();
