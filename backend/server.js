import cors from 'cors';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { execFile, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

const uploadsDir = path.join(__dirname, 'uploads');
const convertedDir = path.join(__dirname, 'converted');

for (const dir of [uploadsDir, convertedDir]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(uploadsDir));
app.use('/converted', express.static(convertedDir));

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadsDir),
  filename: (_, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safeName}`);
  }
});

const allowedExt = new Set(['.pdf', '.doc', '.docx', '.ppt', '.pptx']);

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowedExt.has(ext)) {
      cb(new Error('Only PDF, Word, and PowerPoint files are supported.'));
      return;
    }
    cb(null, true);
  }
});

function convertToHtmlWithLibreOffice(inputPath, outputBaseName) {
  return new Promise((resolve, reject) => {
    const args = [
      '--headless',
      '--convert-to',
      'html',
      '--outdir',
      convertedDir,
      inputPath
    ];

    const sofficeCom = 'C:\\Program Files\\LibreOffice\\program\\soffice.com';
    const sofficePath = fs.existsSync(sofficeCom) ? sofficeCom : 'soffice';
    const sofficeCwd = fs.existsSync(sofficeCom)
      ? 'C:\\Program Files\\LibreOffice\\program'
      : __dirname;

    execFile(
      sofficePath,
      args,
      { timeout: 120000, cwd: sofficeCwd },
      (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(
            `LibreOffice conversion failed. Ensure LibreOffice is installed and soffice is in PATH. Details: ${stderr || stdout || error.message}`
          )
        );
        return;
      }

      const candidateHtml = path.join(
        convertedDir,
        `${path.parse(path.basename(inputPath)).name}.html`
      );

      if (!fs.existsSync(candidateHtml)) {
        reject(new Error('Conversion completed but HTML file not found.'));
        return;
      }

      const finalHtml = path.join(convertedDir, `${outputBaseName}.html`);
      fs.renameSync(candidateHtml, finalHtml);
      resolve(finalHtml);
    }
    );
  });
}

function stripMarkdownFence(text) {
  if (!text) return '';
  return text
    .replace(/^```html\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function textQualityScore(text) {
  const zhCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const badCount = (text.match(/[锟銆鈥鐨闃�]/g) || []).length;
  return zhCount - badCount * 2;
}

function repairMojibakeIfNeeded(text) {
  if (!text || typeof text !== 'string') return text;
  const suspicious = (text.match(/[锟銆鈥鐨闃�]/g) || []).length;
  if (suspicious < 20) return text;

  const candidates = [text];
  const inPath = path.join(convertedDir, `repair_in_${crypto.randomUUID()}.txt`);
  const outPath = path.join(convertedDir, `repair_out_${crypto.randomUUID()}.txt`);
  fs.writeFileSync(inPath, text, 'utf8');

  const psScript = [
    '$ErrorActionPreference = "Stop"',
    `$s = Get-Content -Raw -Encoding UTF8 '${escapePsSingleQuoted(inPath)}'`,
    "$enc = [System.Text.Encoding]::GetEncoding('GB18030')",
    '$fixed = [System.Text.Encoding]::UTF8.GetString($enc.GetBytes($s))',
    `$utf8NoBom = New-Object System.Text.UTF8Encoding($false)`,
    `[System.IO.File]::WriteAllText('${escapePsSingleQuoted(outPath)}', $fixed, $utf8NoBom)`
  ].join('; ');

  try {
    execFileSync('powershell', ['-NoProfile', '-Command', psScript], { timeout: 30000 });
    if (fs.existsSync(outPath)) {
      const repaired = fs.readFileSync(outPath, 'utf8');
      if (repaired && repaired !== text) candidates.push(repaired);
    }
  } catch {
    // ignore conversion attempt failures
  } finally {
    if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  }

  let best = text;
  let bestScore = textQualityScore(text);
  for (const c of candidates) {
    const score = textQualityScore(c);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

function splitText(source, maxLen = 12000) {
  const chunks = [];
  let i = 0;
  while (i < source.length) {
    let end = Math.min(i + maxLen, source.length);
    if (end < source.length) {
      const lastBreak = Math.max(
        source.lastIndexOf('\n', end),
        source.lastIndexOf(' ', end)
      );
      if (lastBreak > i + Math.floor(maxLen * 0.6)) end = lastBreak;
    }
    chunks.push(source.slice(i, end));
    i = end;
  }
  return chunks;
}

function escapePsSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

function toPsHashtable(obj) {
  const pairs = Object.entries(obj).map(
    ([k, v]) => `'${escapePsSingleQuoted(k)}'='${escapePsSingleQuoted(v)}'`
  );
  return `@{${pairs.join(';')}}`;
}

function sanitizeStringForJson(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .replace(/[\uD800-\uDFFF]/g, '');
}

function sanitizePayloadForJson(value) {
  if (typeof value === 'string') return sanitizeStringForJson(value);
  if (Array.isArray(value)) return value.map((v) => sanitizePayloadForJson(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = sanitizePayloadForJson(v);
    }
    return out;
  }
  return value;
}

async function invokeJsonApiWithPowerShell({ url, headers, payload }) {
  const tempBodyPath = path.join(convertedDir, `ai_req_${crypto.randomUUID()}.json`);
  const safePayload = sanitizePayloadForJson(payload);
  fs.writeFileSync(tempBodyPath, JSON.stringify(safePayload), 'utf8');

  const psHeaders = toPsHashtable(headers || {});
  const psScript = [
    '$ErrorActionPreference = "Stop"',
    `$bytes = [System.IO.File]::ReadAllBytes('${escapePsSingleQuoted(tempBodyPath)}')`,
    `$headers = ${psHeaders}`,
    'try {',
    `  $resp = Invoke-WebRequest -Method Post -Uri '${escapePsSingleQuoted(url)}' -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 600`,
    '  $resp.Content',
    '} catch {',
    '  if ($_.Exception -and $_.Exception.Response -and $_.Exception.Response.GetResponseStream) {',
    '    $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())',
    '    $bodyText = $reader.ReadToEnd()',
    '    if ($bodyText) { Write-Output $bodyText; exit 1 }',
    '  }',
    '  if ($_.ErrorDetails -and $_.ErrorDetails.Message) {',
    '    Write-Output $_.ErrorDetails.Message',
    '  } else {',
    '    Write-Output $_.Exception.Message',
    '  }',
    '  exit 1',
    '}'
  ].join('; ');

  try {
    return await new Promise((resolve, reject) => {
      execFile(
        'powershell',
        ['-NoProfile', '-Command', psScript],
        { timeout: 620000 },
        (error, stdout, stderr) => {
          const out = (stdout || '').toString().trim();
          const err = (stderr || '').toString().trim();
          if (error) {
            reject(new Error(out || err || error.message || 'AI API request failed.'));
            return;
          }
          try {
            resolve(JSON.parse(out));
          } catch {
            reject(new Error(out || 'AI API response parse failed.'));
          }
        }
      );
    });
  } finally {
    if (fs.existsSync(tempBodyPath)) fs.unlinkSync(tempBodyPath);
  }
}

async function callOpenAIChat({ apiKey, model, messages }) {
  const data = await invokeJsonApiWithPowerShell({
    url: 'https://api.openai.com/v1/chat/completions',
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    payload: {
      model,
      temperature: 0.1,
      messages
    }
  });

  const content = data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new Error('OpenAI API returned empty content.');
  }
  return stripMarkdownFence(content);
}

async function callClaudeChat({ apiKey, model, messages }) {
  const systemMessages = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
    .trim();

  const conversational = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));

  const data = await invokeJsonApiWithPowerShell({
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    payload: {
      model,
      temperature: 0.1,
      max_tokens: 8192,
      system: systemMessages || undefined,
      messages: conversational
    }
  });

  const contentBlocks = data?.content;
  if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) {
    throw new Error('Claude API returned empty content.');
  }
  const text = contentBlocks
    .filter((b) => b?.type === 'text')
    .map((b) => b?.text || '')
    .join('\n')
    .trim();
  if (!text) {
    throw new Error('Claude API returned non-text content.');
  }
  return repairMojibakeIfNeeded(stripMarkdownFence(text));
}

async function callGeminiChat({ apiKey, model, messages }) {
  const systemMessages = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
    .trim();

  const conversational = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

  const payload = {
    contents: conversational,
    generationConfig: {
      temperature: 0.1
    }
  };
  if (systemMessages) {
    payload.systemInstruction = { parts: [{ text: systemMessages }] };
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const data = await invokeJsonApiWithPowerShell({
    url: endpoint,
    headers: {},
    payload
  });

  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p) => p?.text || '')
    .join('\n')
    .trim();
  if (!text) {
    throw new Error('Gemini API returned empty content.');
  }
  return repairMojibakeIfNeeded(stripMarkdownFence(text));
}

async function callGeminiPdfToHtml({ apiKey, model, pdfPath, originalName }) {
  const pdfBase64 = fs.readFileSync(pdfPath).toString('base64');
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const prompt = [
    `Original filename: ${originalName}`,
    'Task:',
    '1) Read the attached PDF directly.',
    '2) Preserve all meaningful text and structure in original order.',
    '3) Convert to complete HTML5 output (<html>...</html>).',
    '4) Do not summarize. Do not drop content.',
    '5) Return raw HTML only, no markdown fences.'
  ].join('\n');

  const data = await invokeJsonApiWithPowerShell({
    url: endpoint,
    headers: {},
    payload: {
      generationConfig: {
        temperature: 0.1
      },
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            {
              inline_data: {
                mime_type: 'application/pdf',
                data: pdfBase64
              }
            }
          ]
        }
      ]
    }
  });

  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((p) => p?.text || '')
    .join('\n')
    .trim();
  if (!text) {
    throw new Error('Gemini PDF conversion returned empty content.');
  }
  return repairMojibakeIfNeeded(stripMarkdownFence(text));
}

async function callAIChat({ provider, apiKey, model, messages }) {
  if (provider === 'claude') {
    return callClaudeChat({ apiKey, model, messages });
  }
  if (provider === 'gemini') {
    return callGeminiChat({ apiKey, model, messages });
  }
  return callOpenAIChat({ apiKey, model, messages });
}

async function transformHtmlToHtml5ByAI({
  sourceHtml,
  apiKey,
  model,
  provider,
  originalName
}) {
  const chunks = splitText(sourceHtml, 12000);
  const fragments = [];

  for (let i = 0; i < chunks.length; i += 1) {
    const partIndex = i + 1;
    const chunk = chunks[i];
    const chunkHtml = await callAIChat({
      provider,
      apiKey,
      model,
      messages: [
        {
          role: 'system',
          content:
            'You convert source document content into clean HTML5 fragments. Preserve all meaningful content in original order. Do not summarize, omit, or translate. If mojibake appears (for example "éæ¤æ·", "銆愬墠缃"), repair it to readable Chinese. Output only valid HTML fragment, no markdown fences.'
        },
        {
          role: 'user',
          content: [
            `Original filename: ${originalName}`,
            `Chunk ${partIndex}/${chunks.length}`,
            'Task:',
            '1) Keep every meaningful text/item in this chunk.',
            '2) Use semantic HTML tags (<section>, <h1-h6>, <p>, <ul>, <ol>, <table>, <blockquote>, <pre>) when appropriate.',
            '3) Do not include <html>, <head>, <body>.',
            '4) Return one <section data-chunk="N">...</section> fragment.',
            '',
            'Source chunk:',
            chunk
          ].join('\n')
        }
      ]
    });
    fragments.push(chunkHtml);
  }

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${originalName} - HTML5 Preview</title>
    <style>
      :root { color-scheme: light; }
      body { margin: 0; font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #1f2937; background: #f8fafc; }
      .page { max-width: 960px; margin: 0 auto; padding: 24px; background: #fff; min-height: 100vh; box-shadow: 0 0 0 1px #e5e7eb; }
      h1,h2,h3,h4,h5,h6 { line-height: 1.35; margin: 1.2em 0 0.5em; }
      p,li,td,th { line-height: 1.7; }
      table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
      th,td { border: 1px solid #d1d5db; padding: 8px; vertical-align: top; }
      pre { white-space: pre-wrap; background: #f3f4f6; padding: 12px; border-radius: 8px; }
      img { max-width: 100%; height: auto; }
      section[data-chunk] { margin-bottom: 1rem; }
    </style>
  </head>
  <body>
    <main class="page">
${fragments.join('\n')}
    </main>
  </body>
</html>`;
}

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const apiKey = req.headers['x-user-api-key'];
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
      return res.status(400).json({ error: 'Missing API key. Please provide your own API key.' });
    }

    const provider = (req.headers['x-ai-provider'] || 'openai').toString().trim().toLowerCase();
    if (!['openai', 'claude', 'gemini'].includes(provider)) {
      return res.status(400).json({ error: 'Unsupported provider. Use openai, claude, or gemini.' });
    }
    const defaultModel =
      provider === 'claude'
        ? 'claude-3-5-sonnet-20241022'
        : provider === 'gemini'
          ? 'gemini-2.5-pro'
          : 'gpt-4.1-mini';
    const model = (req.headers['x-ai-model'] || defaultModel).toString();
    const fixedOriginalName = repairMojibakeIfNeeded(req.file.originalname);
    const ext = path.extname(fixedOriginalName).toLowerCase();
    const baseName = path.parse(req.file.filename).name;
    let aiHtml = '';

    if (provider === 'gemini' && ext === '.pdf') {
      aiHtml = await callGeminiPdfToHtml({
        apiKey: apiKey.trim(),
        model,
        pdfPath: req.file.path,
        originalName: fixedOriginalName
      });
    } else {
      const rawHtmlPath = await convertToHtmlWithLibreOffice(req.file.path, `${baseName}_raw`);
      const sourceHtml = repairMojibakeIfNeeded(fs.readFileSync(rawHtmlPath, 'utf8'));
      if (!sourceHtml.trim()) {
        return res.status(500).json({
          error: 'Document extraction returned empty content. Please verify the source file is text-based.'
        });
      }

      aiHtml = await transformHtmlToHtml5ByAI({
        sourceHtml,
        apiKey: apiKey.trim(),
        provider,
        model,
        originalName: fixedOriginalName
      });
    }

    const finalName = `${Date.now()}_${crypto.randomUUID()}.html`;
    const finalPath = path.join(convertedDir, finalName);
    fs.writeFileSync(finalPath, aiHtml, 'utf8');

    return res.json({
      ok: true,
      type: 'html',
      originalName: fixedOriginalName,
      previewUrl: `/converted/${finalName}`,
      note: 'AI has analyzed the document and generated an HTML5 preview.'
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || 'Upload/convert failed.'
    });
  }
});

app.get('/api/health', (_, res) => {
  res.json({ ok: true, service: 'h5transformer-backend' });
});

app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
});
