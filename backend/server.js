import cors from 'cors';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

const uploadsDir = path.join(__dirname, 'uploads');
const convertedDir = path.join(__dirname, 'converted');
const scriptsDir = path.join(__dirname, 'scripts');

for (const dir of [uploadsDir, convertedDir, scriptsDir]) {
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

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.pdf') {
      cb(new Error('Only PDF files are supported in current pipeline.'));
      return;
    }
    cb(null, true);
  }
});

function runPdfPipeline({ inputPath, originalName, taskId }) {
  return new Promise((resolve, reject) => {
    const taskDir = path.join(convertedDir, taskId);
    if (!fs.existsSync(taskDir)) fs.mkdirSync(taskDir, { recursive: true });

    const pythonCandidates = [
      process.env.PYTHON_EXE,
      'C:\\Users\\liujiyu\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
      'python'
    ].filter(Boolean);
    const pythonExe = pythonCandidates.find((p) => p.includes(':') ? fs.existsSync(p) : true);
    const scriptPath = path.join(scriptsDir, 'pdf_to_h5.py');
    const tesseractExe = process.env.TESSERACT_PATH || 'C:\\Program Files\\Tesseract-OCR\\tesseract.exe';

    const args = [
      scriptPath,
      '--input',
      inputPath,
      '--outdir',
      taskDir,
      '--original-name',
      originalName,
      '--tesseract',
      tesseractExe
    ];

    execFile(pythonExe, args, { timeout: 900000 }, (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(
            `PDF pipeline failed. Details: ${(stderr || stdout || error.message || '').toString().trim()}`
          )
        );
        return;
      }

      let payload = null;
      try {
        payload = JSON.parse((stdout || '').toString());
      } catch {
        reject(new Error('Pipeline returned invalid JSON payload.'));
        return;
      }

      if (!payload?.ok) {
        reject(new Error(payload?.error || 'Pipeline execution failed.'));
        return;
      }

      resolve(payload);
    });
  });
}

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const taskId = crypto.randomUUID();
    const result = await runPdfPipeline({
      inputPath: req.file.path,
      originalName: req.file.originalname,
      taskId
    });

    return res.json({
      ok: true,
      type: 'html',
      originalName: req.file.originalname,
      previewUrl: `/converted/${taskId}/index.html`,
      note: `Generated ${result.pages || 0} pages with text/image/OCR overlays.`
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
