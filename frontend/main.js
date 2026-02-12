const API_BASE = 'http://localhost:3001';

const RECOMMENDED_MODELS = {
  openai: 'gpt-4.1-mini',
  claude: 'claude-3-5-sonnet-20241022',
  gemini: 'gemini-2.5-pro'
};

let userApiKey = '';
let aiProvider = 'openai';
let aiModel = '';
let isModelTouched = false;

const appShell = document.querySelector('.app-shell');
const uploader = document.getElementById('uploader');
const previewPanel = document.getElementById('previewPanel');
const previewBody = document.getElementById('previewBody');
const fileName = document.getElementById('fileName');
const uploadForm = document.getElementById('uploadForm');
const fileInput = document.getElementById('fileInput');
const submitBtn = document.getElementById('submitBtn');
const statusText = document.getElementById('statusText');
const apiGate = document.getElementById('apiGate');
const apiForm = document.getElementById('apiForm');
const apiKeyInput = document.getElementById('apiKeyInput');
const apiSubmitBtn = document.getElementById('apiSubmitBtn');
const apiGateStatus = document.getElementById('apiGateStatus');
const providerSelect = document.getElementById('providerSelect');
const modelInput = document.getElementById('modelInput');

const requiredNodes = [
  appShell,
  uploader,
  previewPanel,
  previewBody,
  fileName,
  uploadForm,
  fileInput,
  submitBtn,
  statusText,
  apiGate,
  apiForm,
  apiKeyInput,
  apiSubmitBtn,
  apiGateStatus,
  providerSelect,
  modelInput
];

if (requiredNodes.some((node) => !node)) {
  throw new Error('UI initialization failed: missing required DOM nodes.');
}

function setStatus(text, type = 'idle') {
  statusText.textContent = text;
  statusText.classList.remove('is-error', 'is-success', 'is-pending');
  if (type === 'error') statusText.classList.add('is-error');
  if (type === 'success') statusText.classList.add('is-success');
  if (type === 'pending') statusText.classList.add('is-pending');
}

function setApiGateStatus(text, type = 'idle') {
  apiGateStatus.textContent = text;
  apiGateStatus.classList.remove('is-error', 'is-success', 'is-pending');
  if (type === 'error') apiGateStatus.classList.add('is-error');
  if (type === 'success') apiGateStatus.classList.add('is-success');
  if (type === 'pending') apiGateStatus.classList.add('is-pending');
}

function renderPreview(url) {
  previewBody.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.src = `${API_BASE}${url}`;
  iframe.title = 'Converted Preview';
  previewBody.appendChild(iframe);
}

function applyRecommendedModel(provider) {
  const recommended = RECOMMENDED_MODELS[provider] || '';
  modelInput.placeholder = recommended
    ? `Model (default: ${recommended})`
    : 'Model (optional)';
  if (!isModelTouched || !modelInput.value.trim()) {
    modelInput.value = recommended;
  }
}

providerSelect.addEventListener('change', () => {
  aiProvider = providerSelect.value;
  applyRecommendedModel(aiProvider);
});

modelInput.addEventListener('input', () => {
  isModelTouched = true;
});

apiForm.addEventListener('submit', (event) => {
  event.preventDefault();

  const value = apiKeyInput.value.trim();
  if (!value) {
    setApiGateStatus('API Key is required.', 'error');
    return;
  }

  userApiKey = value;
  aiProvider = providerSelect.value;
  aiModel = modelInput.value.trim();

  apiGate.classList.add('hidden');
  setStatus(`API key is set. Provider: ${aiProvider}. Select a file to continue.`);
});

fileInput.addEventListener('change', () => {
  const selected = fileInput.files?.[0];
  if (!selected) {
    setStatus('Please select a file to start.');
    return;
  }
  setStatus(`Selected: ${selected.name}`);
});

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!userApiKey) {
    apiGate.classList.remove('hidden');
    setApiGateStatus('Please enter your API key first.', 'error');
    return;
  }

  const file = fileInput.files?.[0];
  if (!file) {
    setStatus('Please select a file first.', 'error');
    return;
  }

  const formData = new FormData();
  formData.append('file', file);

  submitBtn.disabled = true;
  submitBtn.textContent = 'Uploading...';
  setStatus('Uploading and converting. Please wait...', 'pending');

  try {
    const resp = await fetch(`${API_BASE}/api/upload`, {
      method: 'POST',
      headers: {
        'x-user-api-key': userApiKey,
        'x-ai-provider': aiProvider,
        ...(aiModel ? { 'x-ai-model': aiModel } : {})
      },
      body: formData
    });

    let data = null;
    try {
      data = await resp.json();
    } catch {
      throw new Error('Server returned invalid JSON.');
    }

    if (!resp.ok) {
      throw new Error(data.error || 'Upload failed.');
    }

    appShell.classList.add('has-preview');
    uploader.classList.add('docked');
    previewPanel.classList.remove('hidden');

    fileName.textContent = data.originalName || file.name;
    renderPreview(data.previewUrl);
    setStatus(data.note || 'Upload and conversion succeeded.', 'success');
  } catch (error) {
    setStatus(error.message || 'Upload failed.', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Upload and Convert';
  }
});

applyRecommendedModel(providerSelect.value);
