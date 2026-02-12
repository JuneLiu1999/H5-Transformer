const API_BASE = 'http://localhost:3001';

const appShell = document.querySelector('.app-shell');
const uploader = document.getElementById('uploader');
const previewPanel = document.getElementById('previewPanel');
const previewBody = document.getElementById('previewBody');
const fileName = document.getElementById('fileName');
const uploadForm = document.getElementById('uploadForm');
const fileInput = document.getElementById('fileInput');
const submitBtn = document.getElementById('submitBtn');
const statusText = document.getElementById('statusText');

const requiredNodes = [
  appShell,
  uploader,
  previewPanel,
  previewBody,
  fileName,
  uploadForm,
  fileInput,
  submitBtn,
  statusText
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

function renderPreview(url) {
  previewBody.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.src = `${API_BASE}${url}`;
  iframe.title = 'H5 Converted Preview';
  previewBody.appendChild(iframe);
}

fileInput.addEventListener('change', () => {
  const selected = fileInput.files?.[0];
  if (!selected) {
    setStatus('请选择 PDF 文件开始转换');
    return;
  }
  if (!selected.name.toLowerCase().endsWith('.pdf')) {
    setStatus('当前仅支持 PDF 文件', 'error');
    return;
  }
  setStatus(`已选择：${selected.name}`);
});

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const file = fileInput.files?.[0];
  if (!file) {
    setStatus('请先选择文件', 'error');
    return;
  }
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    setStatus('当前仅支持 PDF 文件', 'error');
    return;
  }

  const formData = new FormData();
  formData.append('file', file);

  submitBtn.disabled = true;
  submitBtn.textContent = '处理中...';
  setStatus('正在执行 PDF 渲染、文字坐标抽取、OCR 与 H5 生成，请稍候...', 'pending');

  try {
    const resp = await fetch(`${API_BASE}/api/upload`, {
      method: 'POST',
      body: formData
    });

    let data = null;
    try {
      data = await resp.json();
    } catch {
      throw new Error('服务端返回格式错误');
    }

    if (!resp.ok) {
      throw new Error(data.error || '上传失败');
    }

    appShell.classList.add('has-preview');
    uploader.classList.add('docked');
    previewPanel.classList.remove('hidden');

    fileName.textContent = data.originalName || file.name;
    renderPreview(data.previewUrl);
    setStatus(data.note || '转换完成', 'success');
  } catch (error) {
    setStatus(error.message || '上传失败', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '上传并转换';
  }
});
