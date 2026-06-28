require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');

const app = express();

const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5500,http://127.0.0.1:5500')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;

  try {
    const { hostname } = new URL(origin);
    if (hostname.endsWith('.github.io')) return true;
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  } catch (err) {
    return false;
  }

  return false;
};

app.use(cors({
  origin(origin, callback) {
    callback(null, isAllowedOrigin(origin));
  }
}));
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
  fs.mkdirSync(path.join(__dirname, 'uploads'));
}

const requiredEnv = ['MONGODB_URI', 'JWT_SECRET', 'ADMIN_NAME', 'ADMIN_CIN', 'ADMIN_PASSWORD'];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// AI Configuration (OpenAI-compatible API)
// Groq free models: llama-3.3-70b-versatile, llama-3.1-8b-instant, gemma-2-9b-it
// OpenAI models: gpt-4o-mini, gpt-4o
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_API_BASE = process.env.AI_API_BASE || 'https://api.openai.com/v1';
const AI_MODEL = process.env.AI_MODEL || 'llama-3.3-70b-versatile';
const aiEnabled = !!AI_API_KEY;

// ========== GEMINI AI STUDIO CONFIG FOR COMPETITIVE MOCK TESTS ==========
// Google AI Studio free tier: 1M TPM, 60 RPM, 1,500 RPD
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const geminiEnabled = !!GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.0-flash';

// Fallback Groq keys (kept for compatibility, but Gemini is preferred)
const AI_API_MOCK_KEYS = [];
for (let i = 1; i <= 10; i++) {
  const key = process.env[`AI_API_MOCK${i}`];
  if (key) AI_API_MOCK_KEYS.push(key);
}
if (AI_API_MOCK_KEYS.length === 0) {
  const fallback = process.env.AI_API_MOCK || process.env.AI_API_KEY || '';
  if (fallback) AI_API_MOCK_KEYS.push(fallback);
}
const aiMockEnabled = geminiEnabled || AI_API_MOCK_KEYS.length > 0;

function getRandomMockKey() {
  return AI_API_MOCK_KEYS[Math.floor(Math.random() * AI_API_MOCK_KEYS.length)];
}

// Global rate-limit tracker (only used for Groq fallback)
let nextSafeRequestTime = 0;
function recordRateLimit(retryAfterSeconds) {
  nextSafeRequestTime = Date.now() + (retryAfterSeconds * 1000) + 2000;
}
function waitForSafeRequest() {
  const waitMs = nextSafeRequestTime - Date.now();
  if (waitMs > 0) {
    console.log(`[Competitive Mock] Waiting ${Math.ceil(waitMs / 1000)}s for rate limit...`);
    return delay(waitMs);
  }
  return Promise.resolve();
}

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB Atlas'))
  .catch((err) => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

// Delay helper
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== GEMINI API CALL ==========
// Google AI Studio (Gemini) has 1M TPM free tier — perfect for competitive exam generation
async function callGemini(prompt) {
  if (!geminiEnabled) {
    return { success: false, error: 'Gemini API key not configured', content: null };
  }
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 8192,
          topP: 0.95,
          topK: 40
        }
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Gemini API error:', errText);
      return { success: false, error: `Gemini API error: ${res.status}`, content: null };
    }

    const data = await res.json();
    
    // Handle Gemini response format
    if (data.error) {
      console.error('Gemini API error:', data.error);
      return { success: false, error: data.error.message || 'Gemini error', content: null };
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || null;
    if (!text) {
      console.error('Gemini returned no text content');
      return { success: false, error: 'Empty response from Gemini', content: null };
    }

    return { success: true, error: null, content: text };
  } catch (err) {
    console.error('Gemini call failed:', err);
    return { success: false, error: err.message, content: null };
  }
}

// ========== GROQ FALLBACK (kept for compatibility) ==========
async function callGroqMock(prompt, apiKey) {
  if (!apiKey) {
    return { success: false, rateLimited: false, retryAfter: 0, error: 'No API key', content: null };
  }
  try {
    const maxTokens = 3000;
    const res = await fetch(`${AI_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: 'You are an expert competitive exam question setter. You generate tough, exam-level questions. You always respond with valid JSON only, no markdown, no explanations, no code blocks.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: maxTokens
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      try {
        const errData = JSON.parse(errText);
        if (errData?.error?.code === 'rate_limit_exceeded') {
          const msg = errData.error.message || '';
          const retryMatch = msg.match(/try again in ([\d.]+)s/i);
          const retryAfter = retryMatch ? parseFloat(retryMatch[1]) : 60;
          recordRateLimit(retryAfter);
          return { success: false, rateLimited: true, retryAfter, content: null };
        }
      } catch (e) {}
      console.error('Groq API error:', errText);
      return { success: false, rateLimited: false, retryAfter: 0, content: null };
    }
    
    const data = await res.json();
    return { success: true, rateLimited: false, retryAfter: 0, content: data.choices?.[0]?.message?.content || null };
  } catch (err) {
    console.error('Groq call failed:', err);
    return { success: false, rateLimited: false, retryAfter: 0, content: null };
  }
}

const studentSchema = new mongoose.Schema({
  name: String,
  roll: Number,
  department: String,
  year: String,
  cin: String,
  downloadsCount: { type: Number, default: 0 },
  contributionsCount: { type: Number, default: 0 },
  role: { type: String, default: 'user' }
});
const Student = mongoose.model('Student', studentSchema);

const contributionSchema = new mongoose.Schema({
  title: String,
  department: String,
  semester: String,
  subject: String,
  materialType: String,
  description: String,
  driveLink: String,
  filePath: String,
  originalFilename: String,
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Student' },
  contributorContributionCount: { type: Number, default: 0 },
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});
const Contribution = mongoose.model('Contribution', contributionSchema);

const noticeSchema = new mongoose.Schema({
  message: String,
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});
const Notice = mongoose.model('Notice', noticeSchema);

const materialSchema = new mongoose.Schema({
  subject: String,
  department: String,
  semester: String,
  title: String,
  type: String,
  url: String,
  date: String,
  createdAt: { type: Date, default: Date.now }
});
const Material = mongoose.model('Material', materialSchema);

const seedMaterialsIfEmpty = async () => {
  const count = await Material.countDocuments();
  if (count > 0) return;

  const seedPath = path.join(__dirname, 'data', 'seed-materials.json');
  if (!fs.existsSync(seedPath)) {
    console.warn('No seed materials file found. Skipping seed.');
    return;
  }

  const seedData = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  await Material.insertMany(seedData);
  console.log(`Seeded ${seedData.length} materials into MongoDB`);
};

mongoose.connection.once('open', () => {
  seedMaterialsIfEmpty().catch((err) => console.error('Material seed failed:', err));
});

// GridFS bucket for persistent file storage (survives redeploys)
let gridfsBucket;
mongoose.connection.once('open', () => {
  gridfsBucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
    bucketName: 'uploads'
  });
  console.log('GridFS bucket initialized');
});

// Use memory storage so files are passed as buffers (then stored in GridFS)
const upload = multer({ storage: multer.memoryStorage() });

// Helper: upload a buffer to GridFS
async function uploadBufferToGridFS(buffer, filename) {
  return new Promise((resolve, reject) => {
    const uploadStream = gridfsBucket.openUploadStream(filename, {
      contentType: 'application/pdf'
    });
    uploadStream.on('finish', () => resolve(uploadStream.id));
    uploadStream.on('error', reject);
    uploadStream.end(buffer);
  });
}

// Helper: download a GridFS file into a Buffer
async function downloadFromGridFS(fileId) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const downloadStream = gridfsBucket.openDownloadStream(new mongoose.Types.ObjectId(fileId));
    downloadStream.on('data', chunk => chunks.push(chunk));
    downloadStream.on('end', () => resolve(Buffer.concat(chunks)));
    downloadStream.on('error', reject);
  });
}

// Helper: delete a file from GridFS
async function deleteFromGridFS(fileId) {
  try {
    await gridfsBucket.delete(new mongoose.Types.ObjectId(fileId));
  } catch (err) {
    console.error('GridFS delete error:', err.message);
  }
}

const authMiddleware = (req, res, next) => {
  const token = req.header('Authorization');
  if (!token) return res.status(401).json({ error: 'Access denied' });
  try {
    const verified = jwt.verify(token.replace('Bearer ', ''), process.env.JWT_SECRET);
    req.user = verified;
    next();
  } catch (err) {
    res.status(400).json({ error: 'Invalid token' });
  }
};

const adminMiddleware = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access only' });
  next();
};

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/materials', async (req, res) => {
  try {
    const materials = await Material.find().sort({ createdAt: -1 }).select('-__v');
    res.json(materials);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load materials' });
  }
});

app.post('/register', async (req, res) => {
  try {
    const { name, roll, department, year, cin } = req.body;
    const rollNum = Number(roll);
    if (!Number.isInteger(rollNum) || rollNum < 500 || rollNum > 599) {
      return res.status(400).send('Roll number invalid');
    }
    const existingUser = await Student.findOne({ $or: [{ cin }, { roll: rollNum }] });
    if (existingUser) return res.status(400).send('CIN or Roll number already registered');

    const student = new Student({ name, roll: rollNum, department, year, cin });
    await student.save();
    res.status(201).send('Registration successful');
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).send('Server error');
  }
});

app.post('/login', async (req, res) => {
  const { name, cin } = req.body;
  try {
    const userByCin = await Student.findOne({ cin });
    if (!userByCin) return res.status(401).send('CIN not found');
    if (userByCin.name !== name) return res.status(401).send("Name doesn't match with CIN");

    const token = jwt.sign({ id: userByCin._id, cin: userByCin.cin, role: userByCin.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(200).json({ message: 'Login successful', token, user: userByCin });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).send('Server error');
  }
});

app.post('/admin-login', async (req, res) => {
  const { name, cin, password } = req.body;
  if (name === process.env.ADMIN_NAME && cin === process.env.ADMIN_CIN && password === process.env.ADMIN_PASSWORD) {
    const token = jwt.sign({ id: 'admin_id', cin: 'admin', role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(200).json({ message: 'Admin login successful', token, user: { name: 'Admin', cin: 'admin', role: 'admin' } });
  } else {
    res.status(401).send('Invalid admin credentials');
  }
});

app.get('/api/user/profile', authMiddleware, async (req, res) => {
  try {
    if (req.user.role === 'admin') {
      return res.json({ name: 'Admin', cin: 'admin', downloadsCount: 0, contributionsCount: 0, role: 'admin' });
    }
    const user = await Student.findById(req.user.id).select('-__v');
    res.json(user);
  } catch (err) {
    res.status(500).send('Server error');
  }
});

const validateDriveLink = (driveLink) => /^https?:\/\/(drive|docs)\.google\.com\//i.test((driveLink || '').trim());

app.post('/api/contribute', authMiddleware, async (req, res) => {
  try {
    const { title, department, semester, subject, materialType, description, driveLink } = req.body;
    if (!validateDriveLink(driveLink)) {
      return res.status(400).send('Please submit a valid Google Drive link');
    }

    const uploader = await Student.findById(req.user.id).select('contributionsCount');

    const contribution = new Contribution({
      title, department, semester, subject, materialType, description,
      driveLink: driveLink.trim(),
      filePath: '',
      originalFilename: '',
      uploadedBy: req.user.id,
      contributorContributionCount: uploader ? uploader.contributionsCount : 0
    });
    await contribution.save();
    res.status(201).json({ message: 'Contribution submitted for review' });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

app.post('/api/download-track', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      await Student.findByIdAndUpdate(req.user.id, { $inc: { downloadsCount: 1 } });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/notices/active', async (req, res) => {
  try {
    const notice = await Notice.findOne({ active: true }).sort({ createdAt: -1 });
    res.json(notice || { message: null });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/demographics', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const deptStats = await Student.aggregate([
      { $group: { _id: '$department', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    const yearStats = await Student.aggregate([
      { $group: { _id: '$year', count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);
    res.json({ department: deptStats, year: yearStats });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/metrics', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const totalDownloadsResult = await Student.aggregate([{ $group: { _id: null, total: { $sum: '$downloadsCount' } } }]);
    const totalDownloads = totalDownloadsResult.length > 0 ? totalDownloadsResult[0].total : 0;

    const totalContributionsResult = await Student.aggregate([{ $group: { _id: null, total: { $sum: '$contributionsCount' } } }]);
    const totalContributions = totalContributionsResult.length > 0 ? totalContributionsResult[0].total : 0;

    const topContributors = await Student.find().sort({ contributionsCount: -1 }).limit(3).select('name department contributionsCount');
    const topDownloader = await Student.find().sort({ downloadsCount: -1 }).limit(1).select('name department downloadsCount');
    const deptStats = await Student.aggregate([
      { $group: { _id: '$department', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    const yearStats = await Student.aggregate([
      { $group: { _id: '$year', count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);

    res.json({
      totalDownloads,
      totalContributions,
      topContributors,
      topDownloader: topDownloader[0],
      demographics: { department: deptStats, year: yearStats }
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/contributions/pending', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const contributions = await Contribution.find({ status: 'pending' }).populate('uploadedBy', 'name cin contributionsCount');
    res.json(contributions);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/materials', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const materials = await Material.find().sort({ createdAt: -1 }).select('-__v');
    res.json(materials);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load materials' });
  }
});

app.delete('/api/admin/materials/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const deleted = await Material.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Material not found' });
    res.json({ success: true, deleted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete material' });
  }
});

app.put('/api/admin/contributions/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const allowedFields = ['title', 'department', 'semester', 'subject', 'materialType', 'description', 'driveLink'];
    const updates = {};

    allowedFields.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        updates[field] = typeof req.body[field] === 'string' ? req.body[field].trim() : req.body[field];
      }
    });

    if (updates.driveLink && !validateDriveLink(updates.driveLink)) {
      return res.status(400).json({ error: 'Please submit a valid Google Drive link' });
    }

    const contribution = await Contribution.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { $set: updates },
      { new: true }
    ).populate('uploadedBy', 'name cin contributionsCount');

    if (!contribution) return res.status(404).json({ error: 'Pending contribution not found' });
    res.json(contribution);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/contributions/:id/approve', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const contribution = await Contribution.findById(req.params.id).populate('uploadedBy');
    if (!contribution) return res.status(404).json({ error: 'Not found' });

    await Material.create({
      subject: contribution.subject,
      department: contribution.department,
      semester: contribution.semester,
      title: contribution.title,
      type: contribution.materialType,
      url: contribution.driveLink,
      date: new Date().toLocaleDateString()
    });

    contribution.status = 'approved';
    if (contribution.uploadedBy) {
      contribution.contributorContributionCount = (contribution.uploadedBy.contributionsCount || 0) + 1;
    }
    await contribution.save();

    if (contribution.uploadedBy) {
      await Student.findByIdAndUpdate(contribution.uploadedBy._id, { $inc: { contributionsCount: 1 } });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/notices', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { message } = req.body;
    await Notice.updateMany({}, { active: false });
    if (message && message.trim().length > 0) {
      const notice = new Notice({ message, active: true });
      await notice.save();
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

const mockTestPaperSchema = new mongoose.Schema({
  title: String,
  subject: String,
  department: String,
  semester: String,
  year: String,
  duration: { type: Number, default: 60 },
  totalMarks: { type: Number, default: 0 },
  totalQuestions: { type: Number, default: 0 },
  pdfFiles: [{
    gridfsId: { type: mongoose.Schema.Types.ObjectId, index: true },
    filename: String,
    originalName: String,
    path: String,        // legacy disk path (kept for backward compat)
    url: String,         // legacy URL (kept for backward compat)
    uploadedAt: { type: Date, default: Date.now }
  }],
  pdfUrl: String,       // legacy single PDF (kept for backward compat)
  pdfFilePath: String,  // legacy single PDF (kept for backward compat)
  syllabusFiles: [{
    gridfsId: { type: mongoose.Schema.Types.ObjectId, index: true },
    filename: String,
    originalName: String,
    path: String,
    url: String,
    uploadedAt: { type: Date, default: Date.now }
  }],
  syllabusText: String, // cached extracted text from syllabus PDFs
  status: { type: String, default: 'active' },
  createdAt: { type: Date, default: Date.now }
});
const MockTestPaper = mongoose.model('MockTestPaper', mockTestPaperSchema);

const mockQuestionSchema = new mongoose.Schema({
  paperId: { type: mongoose.Schema.Types.ObjectId, ref: 'MockTestPaper' },
  question: String,
  options: [String],
  correctAnswer: Number,
  marks: { type: Number, default: 1 },
  difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
  topic: String,
  createdAt: { type: Date, default: Date.now }
});
const MockQuestion = mongoose.model('MockQuestion', mockQuestionSchema);

const mockTestResultSchema = new mongoose.Schema({
  userId: String, // can be MongoDB ObjectId (regular users) or 'admin_id' (admin)
  paperId: { type: mongoose.Schema.Types.ObjectId, ref: 'MockTestPaper' },
  answers: [{ questionId: { type: mongoose.Schema.Types.Mixed }, selectedOption: Number, textAnswer: String, fileId: String, fileName: String }],
  score: Number,
  totalMarks: Number,
  correctCount: Number,
  wrongCount: Number,
  unansweredCount: Number,
  timeTaken: Number,
  completedAt: { type: Date, default: Date.now }
});
const MockTestResult = mongoose.model('MockTestResult', mockTestResultSchema);

// Ephemeral test session (stores AI-generated questions per test attempt, auto-expires)
const testSessionSchema = new mongoose.Schema({
  paperId: { type: mongoose.Schema.Types.ObjectId, ref: 'MockTestPaper' },
  userId: String, // can be MongoDB ObjectId (regular users) or 'admin_id' (admin)
  questionType: { type: String, enum: ['mcq', 'descriptive', 'mixed'], default: 'mcq' },
  questions: [{
    question: String,
    options: [String],
    correctAnswer: Number,
    modelAnswer: String,
    marks: Number,
    difficulty: String,
    topic: String,
    type: { type: String, enum: ['mcq', 'descriptive'], default: 'mcq' }
  }],
  totalMarks: Number,
  duration: Number,
  createdAt: { type: Date, default: Date.now, expires: 7200 } // auto-delete after 2 hours
});
const TestSession = mongoose.model('TestSession', testSessionSchema);

// ========== COMPETITIVE EXAM MOCK TEST SCHEMAS ==========

const competitiveExamConfigSchema = new mongoose.Schema({
  examName: { type: String, enum: ['NEET', 'JEE', 'GATE', 'WBJEE'], required: true, unique: true },
  displayName: String,
  syllabusFiles: [{
    gridfsId: { type: mongoose.Schema.Types.ObjectId, index: true },
    filename: String,
    originalName: String,
    uploadedAt: { type: Date, default: Date.now }
  }],
  pyqFiles: [{
    gridfsId: { type: mongoose.Schema.Types.ObjectId, index: true },
    filename: String,
    originalName: String,
    uploadedAt: { type: Date, default: Date.now }
  }],
  syllabusText: String,
  pyqText: String,
  duration: { type: Number, default: 180 },
  totalMarks: { type: Number, default: 300 },
  status: { type: String, default: 'active' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
const CompetitiveExamConfig = mongoose.model('CompetitiveExamConfig', competitiveExamConfigSchema);

const competitiveTestSessionSchema = new mongoose.Schema({
  examName: { type: String, enum: ['NEET', 'JEE', 'GATE', 'WBJEE'], required: true },
  userId: String,
  questions: [{
    question: String,
    options: [String],
    correctAnswer: Number,
    modelAnswer: String,
    marks: Number,
    difficulty: String,
    topic: String,
    type: { type: String, enum: ['mcq', 'descriptive'], default: 'mcq' }
  }],
  totalMarks: Number,
  duration: Number,
  createdAt: { type: Date, default: Date.now, expires: 7200 }
});
const CompetitiveTestSession = mongoose.model('CompetitiveTestSession', competitiveTestSessionSchema);

const competitiveTestResultSchema = new mongoose.Schema({
  userId: String,
  examName: String,
  answers: [{ questionId: { type: mongoose.Schema.Types.Mixed }, selectedOption: Number, textAnswer: String, fileId: String, fileName: String }],
  score: Number,
  totalMarks: Number,
  correctCount: Number,
  wrongCount: Number,
  unansweredCount: Number,
  timeTaken: Number,
  completedAt: { type: Date, default: Date.now }
});
const CompetitiveTestResult = mongoose.model('CompetitiveTestResult', competitiveTestResultSchema);

// ========== AI QUESTION GENERATION HELPERS ==========

async function callAI(prompt) {
  if (!aiEnabled) return null;
  try {
    const res = await fetch(`${AI_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: 'You are an expert exam question generator. You generate exam questions from exam papers and syllabi. You always respond with valid JSON only, no markdown, no explanations, no code blocks.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 4000
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error('AI API error:', errText);
      return null;
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error('AI call failed:', err);
    return null;
  }
}

// AI call for Competitive Mock Tests (uses one of the rotating API keys)
async function callAIMock(prompt, apiKey) {
  if (!aiMockEnabled || !apiKey) {
    return { success: false, rateLimited: false, retryAfter: 0, error: 'No API key' };
  }
  try {
    const maxTokens = 3000; // Reduced for Groq fallback (12K TPM limit)

    const res = await fetch(`${AI_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: 'You are an expert competitive exam question setter. You generate tough, exam-level questions. You always respond with valid JSON only, no markdown, no explanations, no code blocks.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: maxTokens
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      const errData = JSON.parse(errText);
      
      if (errData?.error?.code === 'rate_limit_exceeded') {
        const msg = errData.error.message || '';
        const retryMatch = msg.match(/try again in ([\d.]+)s/i);
        const retryAfter = retryMatch ? parseFloat(retryMatch[1]) : 60;
        recordRateLimit(retryAfter);
        return { success: false, rateLimited: true, retryAfter, content: null };
      }
      
      console.error('Groq API error:', errText);
      return { success: false, rateLimited: false, retryAfter: 0, content: null };
    }
    
    const data = await res.json();
    return { 
      success: true, 
      rateLimited: false, 
      retryAfter: 0, 
      content: data.choices?.[0]?.message?.content || null 
    };
  } catch (err) {
    console.error('Groq call failed:', err);
    return { success: false, rateLimited: false, retryAfter: 0, content: null };
  }
}

// Delay helper
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Extract text from PDF buffers
async function extractTextFromBuffers(buffers) {
  const texts = [];
  for (const buffer of buffers) {
    try {
      const pdfData = await pdfParse(buffer);
      if (pdfData.text && pdfData.text.trim()) {
        texts.push(pdfData.text.trim());
      }
    } catch (err) {
      console.error('PDF parse error:', err.message);
    }
  }
  return texts;
}

// Extract text from a list of file objects (with gridfsId or legacy path)
async function extractTextFromFileObjects(fileObjects) {
  const texts = [];
  for (const file of fileObjects) {
    try {
      let buffer = null;
      if (file.gridfsId) {
        buffer = await downloadFromGridFS(file.gridfsId);
      } else if (file.path && fs.existsSync(file.path)) {
        buffer = fs.readFileSync(file.path);
      }
      if (!buffer) continue;
      const pdfData = await pdfParse(buffer);
      if (pdfData.text && pdfData.text.trim()) {
        texts.push(pdfData.text.trim());
      }
    } catch (err) {
      console.error('PDF parse error for', file.originalName || file.filename, ':', err.message);
    }
  }
  return texts;
}

// Extract text from all PDFs of a paper (legacy wrapper)
async function extractTextFromAllPDFs(paper) {
  const files = (paper.pdfFiles || []).filter(f => f.gridfsId || (f.path && fs.existsSync(f.path)));
  if (files.length === 0 && paper.pdfFilePath && fs.existsSync(paper.pdfFilePath)) {
    // Legacy single PDF fallback
    const texts = await extractTextFromBuffers([fs.readFileSync(paper.pdfFilePath)]);
    if (texts.length > 0) return { success: true, text: texts.join('\n\n---\n\n') };
  }

  if (files.length === 0) {
    return { success: false, error: 'No PDF files found for this paper' };
  }

  const texts = await extractTextFromFileObjects(files);
  if (texts.length === 0) {
    return { success: false, error: 'Could not extract text from any PDF. The PDFs may be scanned/image-based.' };
  }

  return { success: true, text: texts.join('\n\n---\n\n') };
}

// Get both PYQ and syllabus texts from a paper
async function getPaperTexts(paper) {
  const pyqFiles = (paper.pdfFiles || []).filter(f => f.gridfsId || (f.path && fs.existsSync(f.path)));
  const syllabusFiles = (paper.syllabusFiles || []).filter(f => f.gridfsId || (f.path && fs.existsSync(f.path)));

  let pyqText = '';
  let syllabusText = '';

  const [pyqTexts, syllabusTexts] = await Promise.all([
    extractTextFromFileObjects(pyqFiles),
    extractTextFromFileObjects(syllabusFiles)
  ]);

  pyqText = pyqTexts.join('\n\n---\n\n');
  syllabusText = syllabusTexts.join('\n\n---\n\n');

  // Legacy fallback for single PDF
  if (!pyqText && paper.pdfFilePath && fs.existsSync(paper.pdfFilePath)) {
    const legacyTexts = await extractTextFromBuffers([fs.readFileSync(paper.pdfFilePath)]);
    pyqText = legacyTexts.join('\n\n---\n\n');
  }

  if (!syllabusText && paper.syllabusText) {
    syllabusText = paper.syllabusText;
  }

  return { pyqText, syllabusText };
}

function getTargetDifficulty(percentage) {
  if (percentage >= 90) return 'hard';
  if (percentage >= 75) return 'medium-hard';
  if (percentage >= 50) return 'medium';
  return 'easy';
}

function getDifficultyInstructions(targetDifficulty) {
  switch (targetDifficulty) {
    case 'easy':
      return `Generate EASY-level questions. Focus on fundamental concepts, direct recall, basic definitions, and straightforward application. Most questions should be simple and accessible, requiring only basic understanding. A few may involve light reasoning (1-2 steps).`;
    case 'medium-hard':
      return `Generate MEDIUM-HARD questions that are slightly harder than the PYQs. Include more challenging application problems, multi-step reasoning, and some non-standard scenarios. About 60% medium and 40% hard, giving a noticeable step up from the PYQ baseline.`;
    case 'hard':
      return `Generate HARD questions that are more challenging than the PYQs. Include advanced application, multi-step analysis, and some edge cases. About 50% hard and 50% medium-hard. Questions should be challenging but still solvable with solid preparation.`;
    default:
      return `Generate MEDIUM-level questions that match the PYQ difficulty. Include a balanced mix of basic recall, conceptual understanding, and moderate problem-solving. About 30% easy, 50% medium, and 20% hard. Keep questions accessible to students with regular preparation.`;
  }
}

function buildAIPrompt(questionType, paper, totalMarks, testDuration, pyqText, syllabusText, targetDifficulty = 'medium') {
  let typeInstructions = '';
  let formatInstructions = '';

  if (questionType === 'mcq') {
    typeInstructions = `Generate ONLY Multiple Choice Questions (MCQ). Each question must have exactly 4 options (A, B, C, D). Mark the correct answer with a 0-based index (0=A, 1=B, 2=C, 3=D).`;
    formatInstructions = `[
  {
    "question": "Question text here",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctAnswer": 0,
    "modelAnswer": "",
    "marks": 1,
    "difficulty": "medium",
    "topic": "topic name",
    "type": "mcq"
  }
]`;
  } else if (questionType === 'descriptive') {
    typeInstructions = `Generate ONLY Descriptive / Long Answer / Short Answer questions. These should NOT have multiple choice options. Instead, provide a model answer that would be expected. Set correctAnswer to -1 and options to an empty array.`;
    formatInstructions = `[
  {
    "question": "Question text here",
    "options": [],
    "correctAnswer": -1,
    "modelAnswer": "Expected answer summary here",
    "marks": 5,
    "difficulty": "medium",
    "topic": "topic name",
    "type": "descriptive"
  }
]`;
  } else {
    typeInstructions = `Generate a MIX of Multiple Choice Questions (MCQ) and Descriptive questions. For MCQs, each must have exactly 4 options (A, B, C, D) with correctAnswer as 0-based index. For Descriptive questions, options should be an empty array and correctAnswer should be -1, with a modelAnswer provided.`;
    formatInstructions = `[
  {
    "question": "MCQ question text",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctAnswer": 0,
    "modelAnswer": "",
    "marks": 1,
    "difficulty": "medium",
    "topic": "topic name",
    "type": "mcq"
  },
  {
    "question": "Descriptive question text",
    "options": [],
    "correctAnswer": -1,
    "modelAnswer": "Expected answer summary",
    "marks": 5,
    "difficulty": "medium",
    "topic": "topic name",
    "type": "descriptive"
  }
]`;
  }

  const prompt = `You are an expert exam question generator. I have provided you with:
1. Previous Year Exam Papers (PYQs) - to understand the difficulty level and pattern
2. Syllabus Content - to guide the topics and coverage

Your task is to generate ${questionType.toUpperCase()} type questions for a new mock test.

PAPER / EXAM DETAILS:
- Paper Name: ${paper.title}
- Subject: ${paper.subject}
- Department: ${paper.department || 'N/A'}
- Semester: ${paper.semester || 'N/A'}
- Total Marks Required: ${totalMarks}
- Duration: ${testDuration} minutes
- Question Type: ${questionType.toUpperCase()}

INSTRUCTIONS:
1. Read through ALL the provided PYQ content carefully to understand the difficulty level and pattern.
2. Read through the syllabus content to understand the topics to cover.
3. ${getDifficultyInstructions(targetDifficulty)}
4. Cover ALL major topics from the syllabus evenly.
5. The total marks of ALL generated questions should closely match ${totalMarks} marks.
6. ${typeInstructions}
7. Include difficulty level (easy, medium, or hard) and a topic tag for each question.
8. Return ONLY a valid JSON array with NO markdown formatting, NO code blocks, NO explanation text outside the JSON.

PREVIOUS YEAR EXAM PAPER CONTENT (PYQs):
${pyqText || 'No PYQ content provided.'}

SYLLABUS CONTENT:
${syllabusText || 'No syllabus provided. Generate based on PYQ topics.'}

JSON FORMAT (return ONLY this array, no other text):
${formatInstructions}`;

  return prompt;
}

// ========== COMPETITIVE EXAM AI PROMPT & GENERATION ==========

// Exam batch plans — how to split each exam into manageable AI batches
function getExamBatchPlan(examName) {
  const plans = {
    'GATE': {
      totalQuestions: 65,
      totalMarks: 100,
      duration: 180,
      batches: [
        { name: 'General Aptitude', count: 10, marks: 15, topics: 'Verbal Ability, Numerical Ability, Logical Reasoning', instructions: 'Generate 10 General Aptitude questions. First 5 questions should be 1-mark each. Next 5 questions should be 2-marks each. Total: 15 marks. These are NON-technical questions testing verbal ability, numerical ability, and logical reasoning.' },
        { name: 'Technical Part A', count: 15, marks: 25, topics: 'Subject-specific technical topics from syllabus', instructions: 'Generate 15 technical subject questions. Mix of 1-mark and 2-mark questions. About 9 questions of 1-mark and 6 questions of 2-mark. Total: ~25 marks. Cover the first portion of the syllabus topics evenly.' },
        { name: 'Technical Part B', count: 15, marks: 25, topics: 'Subject-specific technical topics from syllabus', instructions: 'Generate 15 technical subject questions. Mix of 1-mark and 2-mark questions. About 9 questions of 1-mark and 6 questions of 2-mark. Total: ~25 marks. Cover the middle portion of the syllabus topics evenly.' },
        { name: 'Technical Part C', count: 15, marks: 25, topics: 'Subject-specific technical topics from syllabus', instructions: 'Generate 15 technical subject questions. Mix of 1-mark and 2-mark questions. About 9 questions of 1-mark and 6 questions of 2-mark. Total: ~25 marks. Cover the remaining syllabus topics.' },
        { name: 'Technical Part D', count: 10, marks: 10, topics: 'Subject-specific technical topics from syllabus', instructions: 'Generate 10 technical subject questions. Mix of 1-mark and 2-mark questions. About 6 questions of 1-mark and 4 questions of 2-mark. Total: ~10 marks. Cover any remaining or advanced topics.' }
      ]
    },
    'NEET': {
      totalQuestions: 180,
      totalMarks: 720,
      duration: 180,
      batches: [
        { name: 'Physics Part A', count: 15, marks: 60, topics: 'Physics', instructions: 'Generate 15 Physics questions. Each question is 4 marks (standard NEET pattern). Total: 60 marks. Cover fundamental physics topics evenly.' },
        { name: 'Physics Part B', count: 15, marks: 60, topics: 'Physics', instructions: 'Generate 15 Physics questions. Each question is 4 marks. Total: 60 marks. Cover remaining physics topics.' },
        { name: 'Physics Part C', count: 15, marks: 60, topics: 'Physics', instructions: 'Generate 15 Physics questions. Each question is 4 marks. Total: 60 marks. Cover advanced physics topics.' },
        { name: 'Chemistry Part A', count: 15, marks: 60, topics: 'Chemistry', instructions: 'Generate 15 Chemistry questions. Each question is 4 marks. Total: 60 marks. Cover physical chemistry topics.' },
        { name: 'Chemistry Part B', count: 15, marks: 60, topics: 'Chemistry', instructions: 'Generate 15 Chemistry questions. Each question is 4 marks. Total: 60 marks. Cover organic and inorganic chemistry topics.' },
        { name: 'Chemistry Part C', count: 15, marks: 60, topics: 'Chemistry', instructions: 'Generate 15 Chemistry questions. Each question is 4 marks. Total: 60 marks. Cover remaining chemistry topics.' },
        { name: 'Biology Part A', count: 20, marks: 80, topics: 'Biology', instructions: 'Generate 20 Biology questions (Botany + Zoology). Each question is 4 marks. Total: 80 marks.' },
        { name: 'Biology Part B', count: 20, marks: 80, topics: 'Biology', instructions: 'Generate 20 Biology questions (Botany + Zoology). Each question is 4 marks. Total: 80 marks.' },
        { name: 'Biology Part C', count: 20, marks: 80, topics: 'Biology', instructions: 'Generate 20 Biology questions (Botany + Zoology). Each question is 4 marks. Total: 80 marks.' },
        { name: 'Biology Part D', count: 20, marks: 80, topics: 'Biology', instructions: 'Generate 20 Biology questions (Botany + Zoology). Each question is 4 marks. Total: 80 marks.' },
        { name: 'Biology Part E', count: 20, marks: 80, topics: 'Biology', instructions: 'Generate 20 Biology questions (Botany + Zoology). Each question is 4 marks. Total: 80 marks.' }
      ]
    },
    'JEE': {
      totalQuestions: 90,
      totalMarks: 360,
      duration: 180,
      batches: [
        { name: 'Physics Part A', count: 15, marks: 60, topics: 'Physics', instructions: 'Generate 15 Physics questions. Each question is 4 marks. Total: 60 marks. Cover mechanics and basic physics topics.' },
        { name: 'Physics Part B', count: 15, marks: 60, topics: 'Physics', instructions: 'Generate 15 Physics questions. Each question is 4 marks. Total: 60 marks. Cover electromagnetism and modern physics topics.' },
        { name: 'Chemistry Part A', count: 15, marks: 60, topics: 'Chemistry', instructions: 'Generate 15 Chemistry questions. Each question is 4 marks. Total: 60 marks. Cover physical chemistry topics.' },
        { name: 'Chemistry Part B', count: 15, marks: 60, topics: 'Chemistry', instructions: 'Generate 15 Chemistry questions. Each question is 4 marks. Total: 60 marks. Cover organic and inorganic chemistry topics.' },
        { name: 'Mathematics Part A', count: 15, marks: 60, topics: 'Mathematics', instructions: 'Generate 15 Mathematics questions. Each question is 4 marks. Total: 60 marks. Cover algebra and calculus topics.' },
        { name: 'Mathematics Part B', count: 15, marks: 60, topics: 'Mathematics', instructions: 'Generate 15 Mathematics questions. Each question is 4 marks. Total: 60 marks. Cover geometry, trigonometry, and advanced topics.' }
      ]
    },
    'WBJEE': {
      totalQuestions: 155,
      totalMarks: 200,
      duration: 120,
      batches: [
        { name: 'Mathematics Part A', count: 20, marks: 25, topics: 'Mathematics', instructions: 'Generate 20 Mathematics questions. Mix of 1-mark and 2-mark questions. Total: ~25 marks.' },
        { name: 'Mathematics Part B', count: 20, marks: 25, topics: 'Mathematics', instructions: 'Generate 20 Mathematics questions. Mix of 1-mark and 2-mark questions. Total: ~25 marks.' },
        { name: 'Mathematics Part C', count: 18, marks: 25, topics: 'Mathematics', instructions: 'Generate 18 Mathematics questions. Mix of 1-mark and 2-mark questions. Total: ~25 marks.' },
        { name: 'Physics Part A', count: 15, marks: 20, topics: 'Physics', instructions: 'Generate 15 Physics questions. Mix of 1-mark and 2-mark questions. Total: ~20 marks.' },
        { name: 'Physics Part B', count: 15, marks: 20, topics: 'Physics', instructions: 'Generate 15 Physics questions. Mix of 1-mark and 2-mark questions. Total: ~20 marks.' },
        { name: 'Physics Part C', count: 12, marks: 15, topics: 'Physics', instructions: 'Generate 12 Physics questions. Mix of 1-mark and 2-mark questions. Total: ~15 marks.' },
        { name: 'Chemistry Part A', count: 15, marks: 20, topics: 'Chemistry', instructions: 'Generate 15 Chemistry questions. Mix of 1-mark and 2-mark questions. Total: ~20 marks.' },
        { name: 'Chemistry Part B', count: 12, marks: 15, topics: 'Chemistry', instructions: 'Generate 12 Chemistry questions. Mix of 1-mark and 2-mark questions. Total: ~15 marks.' }
      ]
    }
  };
  return plans[examName] || null;
}

// Build a SINGLE large prompt for Gemini to generate the entire exam at once
function buildFullExamPrompt(examName, totalMarks, duration, pyqText, syllabusText, plan) {
  const diffInstructions = {
    'GATE': `CRITICAL: These must be at GATE (Graduate Aptitude Test in Engineering) difficulty level — one of India's toughest technical exams. Questions require deep conceptual understanding, multi-step problem solving, and application of formulas in non-obvious ways. 60% HARD, 30% MEDIUM, 10% EASY. Every question must have at least one plausible distractor (wrong option) that tests common misconceptions.`,
    'NEET': `CRITICAL: NEET-level difficulty. Biology tests NCERT application beyond rote memorization. Physics is numerical and conceptual. Chemistry tests mechanisms and reactions. 40% HARD, 40% MEDIUM, 20% EASY. Each question is 4 marks.`,
    'JEE': `CRITICAL: JEE Main/Advanced level — among the toughest engineering exams globally. Physics and Chemistry are deeply conceptual with multi-step problems. Mathematics requires clever substitutions and non-obvious approaches. 50% HARD, 35% MEDIUM, 15% EASY. Each question is 4 marks.`,
    'WBJEE': `CRITICAL: WBJEE state-level competitive exam. Mathematics has subtle traps. Physics and Chemistry are moderate. 35% HARD, 45% MEDIUM, 20% EASY.`
  };

  const diffText = diffInstructions[examName] || 'Generate at actual exam difficulty level. 40% HARD, 40% MEDIUM, 20% EASY.';

  // Build section breakdown from the batch plan
  const sectionsText = plan.batches.map((batch, i) => {
    return `Section ${i + 1}: ${batch.name}
- Questions: ${batch.count}
- Marks: ${batch.marks}
- Topics: ${batch.topics}
- ${batch.instructions}`;
  }).join('\n\n');

  return `You are an expert Question Setter for the ${examName} examination. Generate a COMPLETE ${examName} mock test paper with exactly ${plan.totalQuestions} questions that follows the real exam pattern.

${diffText}

EXAM PATTERN:
- Exam: ${examName}
- Total Marks: ${totalMarks}
- Duration: ${duration} minutes
- Total Questions: ${plan.totalQuestions}

SECTION BREAKDOWN:
${sectionsText}

QUESTION RULES:
1. Each question MUST be a Multiple Choice Question with exactly 4 options (A, B, C, D).
2. Correct answer: 0-based index (0=A, 1=B, 2=C, 3=D).
3. Include a detailed modelAnswer with step-by-step reasoning for every question.
4. Include difficulty (easy, medium, hard) and a specific topic tag for each question.
5. Return ONLY a valid JSON array. NO markdown, NO code blocks, NO extra text outside the JSON.
6. CRITICAL: You MUST generate exactly ${plan.totalQuestions} questions total. Do not generate fewer.

PREVIOUS YEAR QUESTION (PYQ) CONTENT (study the pattern and difficulty):
${pyqText || 'No PYQ content provided.'}

SYLLABUS CONTENT (cover these topics evenly):
${syllabusText || 'No syllabus provided.'}

JSON FORMAT (return ONLY this array, no other text):
[
  {
    "question": "Question text here",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctAnswer": 0,
    "modelAnswer": "Detailed step-by-step explanation",
    "marks": 1,
    "difficulty": "hard",
    "topic": "specific topic",
    "type": "mcq"
  }
]`;
}

function buildBatchPrompt(examName, batch, batchIndex, totalBatches, pyqText, syllabusText) {
  // Exam-specific difficulty instructions
  const difficultyInstructions = {
    'GATE': `CRITICAL DIFFICULTY REQUIREMENT:
- You are setting questions for the GATE (Graduate Aptitude Test in Engineering) — one of India's toughest engineering entrance exams.
- The questions must be at the SAME difficulty level as actual GATE PYQs.
- These are NOT simple textbook problems. They require deep conceptual understanding, multi-step problem solving, and application of formulas in non-obvious ways.
- General Aptitude questions should be tricky — not straightforward word problems. Include tricky logical reasoning, pattern-based numerical ability, and subtle verbal questions.
- Technical questions should involve: complex calculations, application of multiple concepts together, diagrams that require interpretation, and problems that test engineering depth.
- Easy questions should still require some thought — not rote memorization.
- 60% of questions should be HARD (2-mark level), 30% MEDIUM (1-mark level), 10% EASY.
- Every question must have at least ONE plausible distractor (wrong option) that a well-prepared student might choose if they make a common mistake.`,

    'NEET': `CRITICAL DIFFICULTY REQUIREMENT:
- You are setting questions for NEET — India's medical entrance exam. Questions must match actual NEET difficulty.
- Biology questions should test NCERT application, not just memorization. Include assertion-reason style thinking.
- Physics questions should be numerical and conceptual. Chemistry should test mechanisms and reactions.
- 40% HARD, 40% MEDIUM, 20% EASY. Each question is 4 marks.`,

    'JEE': `CRITICAL DIFFICULTY REQUIREMENT:
- You are setting questions for JEE Main / Advanced — one of the toughest engineering exams globally.
- Physics and Chemistry must be deeply conceptual with multi-step problems.
- Mathematics must involve clever substitutions, non-obvious approaches, and integration of multiple concepts.
- 50% HARD, 35% MEDIUM, 15% EASY. Each question is 4 marks.`,

    'WBJEE': `CRITICAL DIFFICULTY REQUIREMENT:
- You are setting questions for WBJEE — a competitive state-level exam with tricky questions.
- Mathematics questions often have subtle traps and require careful calculation.
- Physics and Chemistry mix conceptual and numerical at moderate difficulty.
- 35% HARD, 45% MEDIUM, 20% EASY.`
  };

  const diffText = difficultyInstructions[examName] || 'Generate questions at the actual exam difficulty level. 40% HARD, 40% MEDIUM, 20% EASY.';

  return `You are an expert Question Setter for the ${examName} examination. You are generating BATCH ${batchIndex + 1} of ${totalBatches} for a complete mock test paper that mirrors the ACTUAL ${examName} exam pattern.

${diffText}

BATCH DETAILS:
- Section: ${batch.name}
- Questions to Generate in THIS batch: EXACTLY ${batch.count}
- Target Marks for this batch: ${batch.marks}
- Topics: ${batch.topics}
- ${batch.instructions}

EXAM RULES:
- Each question MUST be a Multiple Choice Question with exactly 4 options (A, B, C, D).
- Correct answer index: 0=A, 1=B, 2=C, 3=D.
- At least one wrong option must be a PLAUSIBLE DISTRACTOR that tests common misconceptions.
- Include a detailed modelAnswer with step-by-step reasoning for every question.
- Include difficulty level (easy, medium, hard) and a specific topic tag for each question.
- Return ONLY a valid JSON array. NO markdown, NO code blocks, NO extra text outside the JSON.
- CRITICAL: You MUST generate EXACTLY ${batch.count} questions in this batch. Do not generate fewer.

PREVIOUS YEAR QUESTION (PYQ) CONTENT (study these to understand the exact difficulty and pattern):
${pyqText || 'No PYQ content provided.'}

SYLLABUS CONTENT (cover these topics evenly):
${syllabusText || 'No syllabus provided.'}

JSON FORMAT (return ONLY this array, no other text):
[
  {
    "question": "Question text here",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctAnswer": 0,
    "modelAnswer": "Detailed step-by-step explanation of why this is correct",
    "marks": 1,
    "difficulty": "hard",
    "topic": "specific topic name",
    "type": "mcq"
  }
]`;
}

// Parse AI response into validated questions
function parseAIResponse(aiResponse, batch) {
  if (!aiResponse) return { questions: [], error: 'No AI response' };

  let cleanedResponse = aiResponse.trim();
  if (cleanedResponse.startsWith('```json')) {
    cleanedResponse = cleanedResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  } else if (cleanedResponse.startsWith('```')) {
    cleanedResponse = cleanedResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }
  cleanedResponse = cleanedResponse.trim();

  let rawQuestions;
  try {
    rawQuestions = JSON.parse(cleanedResponse);
  } catch (parseErr) {
    return { questions: [], error: 'JSON parse error: ' + parseErr.message };
  }

  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return { questions: [], error: 'Empty or invalid array' };
  }

  const questions = [];
  for (const q of rawQuestions) {
    if (!q.question) continue;
    if (!Array.isArray(q.options) || q.options.length !== 4) continue;
    if (typeof q.correctAnswer !== 'number' || q.correctAnswer < 0 || q.correctAnswer > 3) continue;
    questions.push({
      question: q.question.trim(),
      options: q.options.map(o => String(o).trim()),
      correctAnswer: Math.round(q.correctAnswer),
      modelAnswer: q.modelAnswer || '',
      marks: Number(q.marks) || 1,
      difficulty: ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : 'medium',
      topic: q.topic || batch.topics,
      type: 'mcq'
    });
  }

  return { questions, error: null };
}

async function generateBatchWithRetry(config, batch, batchIndex, totalBatches, pyqText, syllabusText, maxRetries = 3) {
  const prompt = buildBatchPrompt(config.examName, batch, batchIndex, totalBatches, pyqText, syllabusText);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Wait for global rate limit to clear before any attempt
    await waitForSafeRequest();
    
    const apiKey = getRandomMockKey();
    console.log(`[Competitive Mock] Batch ${batchIndex + 1} attempt ${attempt + 1}/${maxRetries + 1}`);

    const aiResult = await callAIMock(prompt, apiKey);
    
    // Rate limited — the global tracker was already updated by callAIMock, 
    // so the next loop iteration will wait automatically via waitForSafeRequest()
    if (!aiResult.success && aiResult.rateLimited) {
      console.log(`[Competitive Mock] Batch ${batchIndex + 1} rate limited. Will retry after global cooldown.`);
      continue; // Loop again; waitForSafeRequest() will handle the delay
    }
    
    // Other failure
    if (!aiResult.success || !aiResult.content) {
      console.error(`[Competitive Mock] Batch ${batchIndex + 1} attempt ${attempt + 1} failed: API error`);
      continue;
    }

    const result = parseAIResponse(aiResult.content, batch);

    if (result.questions.length > 0) {
      console.log(`[Competitive Mock] Batch ${batchIndex + 1}: ${result.questions.length} valid questions`);
      return { success: true, questions: result.questions };
    }

    console.error(`[Competitive Mock] Batch ${batchIndex + 1} attempt ${attempt + 1} failed: ${result.error}`);
  }

  return { success: false, error: `Failed after ${maxRetries + 1} attempts` };
}

async function generateCompetitiveQuestionsFromExam(config, totalMarks, duration) {
  try {
    if (!aiMockEnabled) {
      return { success: false, error: 'AI not configured. Please set GEMINI_API_KEY or AI_API_MOCK1..10 environment variables.' };
    }

    const plan = getExamBatchPlan(config.examName);
    if (!plan) {
      return { success: false, error: `Unknown exam: ${config.examName}. Supported: NEET, JEE, GATE, WBJEE.` };
    }

    const pyqFiles = (config.pyqFiles || []).filter(f => f.gridfsId);
    const syllabusFiles = (config.syllabusFiles || []).filter(f => f.gridfsId);

    let pyqText = config.pyqText || '';
    let syllabusText = config.syllabusText || '';

    if (!pyqText && pyqFiles.length > 0) {
      const texts = await extractTextFromFileObjects(pyqFiles);
      pyqText = texts.join('\n\n---\n\n');
    }
    if (!syllabusText && syllabusFiles.length > 0) {
      const texts = await extractTextFromFileObjects(syllabusFiles);
      syllabusText = texts.join('\n\n---\n\n');
    }

    if (!pyqText && !syllabusText) {
      return { success: false, error: 'No PYQ or syllabus content found for this exam.' };
    }

    const MAX_CHARS = 3000;
    let combinedPyqText = pyqText;
    if (combinedPyqText.length > MAX_CHARS) {
      combinedPyqText = combinedPyqText.substring(0, MAX_CHARS) + '\n\n[Truncated...]';
    }
    let combinedSyllabusText = syllabusText;
    if (combinedSyllabusText.length > MAX_CHARS) {
      combinedSyllabusText = combinedSyllabusText.substring(0, MAX_CHARS) + '\n\n[Truncated...]';
    }

    // Build exam-specific full prompt
    const prompt = buildFullExamPrompt(config.examName, totalMarks, duration, combinedPyqText, combinedSyllabusText, plan);

    // ====== PRIMARY: Gemini (1M TPM free tier) ======
    if (geminiEnabled) {
      console.log(`[Competitive Mock] Using Gemini (${GEMINI_MODEL}) for ${config.examName} — generating ${plan.totalQuestions} questions in one request...`);
      const startTime = Date.now();
      
      const geminiResult = await callGemini(prompt);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      
      if (geminiResult.success && geminiResult.content) {
        const result = parseAIResponse(geminiResult.content, { topics: config.examName });
        if (result.questions.length > 0) {
          console.log(`[Competitive Mock] Gemini generated ${result.questions.length} questions in ${elapsed}s`);
          return { success: true, questions: result.questions };
        }
      }
      console.log(`[Competitive Mock] Gemini failed or returned empty. Falling back to Groq...`);
    }

    // ====== FALLBACK: Groq (sequential batches) ======
    console.log(`[Competitive Mock] Using Groq fallback for ${config.examName}. ${plan.batches.length} batches, ${AI_API_MOCK_KEYS.length} key(s).`);
    const startTime = Date.now();
    const allQuestions = [];
    let failedBatches = 0;
    const INTER_BATCH_DELAY_MS = 30000;

    for (let i = 0; i < plan.batches.length; i++) {
      const batch = plan.batches[i];
      console.log(`[Competitive Mock] Batch ${i + 1}/${plan.batches.length}: ${batch.name} (${batch.count} questions)`);

      const result = await generateBatchWithRetry(config, batch, i, plan.batches.length, combinedPyqText, combinedSyllabusText, 2);

      if (result.success && result.questions.length > 0) {
        allQuestions.push(...result.questions);
        console.log(`[Competitive Mock] Batch ${i + 1} complete. Total: ${allQuestions.length} questions.`);
      } else {
        failedBatches++;
        console.error(`[Competitive Mock] Batch ${i + 1} failed.`);
      }

      if (i < plan.batches.length - 1) {
        console.log(`[Competitive Mock] Waiting ${INTER_BATCH_DELAY_MS / 1000}s before next batch...`);
        await delay(INTER_BATCH_DELAY_MS);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Competitive Mock] Groq fallback completed in ${elapsed}s`);

    if (allQuestions.length === 0) {
      return { success: false, error: 'All generation attempts failed. Please check AI configuration.' };
    }

    console.log(`[Competitive Mock] Generated ${allQuestions.length} questions (target: ${plan.totalQuestions}).`);
    return { success: true, questions: allQuestions };
  } catch (err) {
    console.error('generateCompetitiveQuestionsFromExam error:', err);
    return { success: false, error: err.message };
  }
}

// Generate questions from ALL PDFs of a paper using AI
async function generateQuestionsFromPaper(paper, questionType = 'mcq') {
  try {
    if (!aiEnabled) {
      return { success: false, error: 'AI API not configured. Please set AI_API_KEY and AI_API_BASE environment variables.' };
    }

    const { pyqText, syllabusText } = await getPaperTexts(paper);
    if (!pyqText) {
      return { success: false, error: 'No PYQ text found for this paper.' };
    }

    let combinedPyqText = pyqText;
    const MAX_CHARS = 12000;
    if (combinedPyqText.length > MAX_CHARS) {
      combinedPyqText = combinedPyqText.substring(0, MAX_CHARS) + '\n\n[Additional PYQ content truncated...]';
    }

    const prompt = buildAIPrompt(questionType, paper, paper.totalMarks || 30, paper.duration || 60, combinedPyqText, syllabusText);

    const aiResponse = await callAI(prompt);
    if (!aiResponse) {
      return { success: false, error: 'AI generation failed. Please check your AI API configuration (AI_API_KEY, AI_API_BASE).' };
    }

    // Clean up response - extract JSON from possible markdown code blocks
    let cleanedResponse = aiResponse.trim();
    if (cleanedResponse.startsWith('```json')) {
      cleanedResponse = cleanedResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleanedResponse.startsWith('```')) {
      cleanedResponse = cleanedResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }
    cleanedResponse = cleanedResponse.trim();

    let rawQuestions;
    try {
      rawQuestions = JSON.parse(cleanedResponse);
    } catch (parseErr) {
      console.error('AI JSON parse error:', parseErr.message);
      console.error('Raw response (first 500 chars):', cleanedResponse.substring(0, 500));
      return { success: false, error: 'AI returned invalid JSON format. The AI response could not be parsed into questions.' };
    }

    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
      return { success: false, error: 'AI generated no valid questions.' };
    }

    // Validate and normalize each question
    const questions = [];
    for (const q of rawQuestions) {
      if (!q.question) continue;
      const qType = q.type === 'descriptive' ? 'descriptive' : 'mcq';
      if (qType === 'mcq') {
        if (!Array.isArray(q.options) || q.options.length !== 4) continue;
        if (typeof q.correctAnswer !== 'number' || q.correctAnswer < 0 || q.correctAnswer > 3) continue;
      } else {
        // descriptive: options can be empty, correctAnswer should be -1
        if (!Array.isArray(q.options)) q.options = [];
      }
      questions.push({
        paperId: new mongoose.Types.ObjectId(paper._id),
        question: q.question.trim(),
        options: Array.isArray(q.options) ? q.options.map(o => String(o).trim()) : [],
        correctAnswer: qType === 'descriptive' ? -1 : Math.round(q.correctAnswer),
        modelAnswer: q.modelAnswer || '',
        marks: Number(q.marks) || 1,
        difficulty: ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : 'medium',
        topic: q.topic || '',
        type: qType
      });
    }

    if (questions.length === 0) {
      return { success: false, error: 'No valid questions after validation. The AI response did not contain properly formatted questions.' };
    }

    // Delete existing questions for this paper before saving new ones
    await MockQuestion.deleteMany({ paperId: new mongoose.Types.ObjectId(paper._id) });
    await MockQuestion.insertMany(questions);

    // Recalculate totals from actual saved questions
    const count = await MockQuestion.countDocuments({ paperId: new mongoose.Types.ObjectId(paper._id) });
    const totalMarksResult = await MockQuestion.aggregate([
      { $match: { paperId: new mongoose.Types.ObjectId(paper._id) } },
      { $group: { _id: null, total: { $sum: '$marks' } } }
    ]);
    const actualTotalMarks = totalMarksResult.length > 0 ? totalMarksResult[0].total : 0;

    await MockTestPaper.findByIdAndUpdate(paper._id, {
      totalQuestions: count,
      totalMarks: actualTotalMarks
    });

    return {
      success: true,
      count: questions.length,
      totalMarks: actualTotalMarks,
      usedAI: true
    };
  } catch (err) {
    console.error('generateQuestionsFromPaper error:', err);
    return { success: false, error: err.message };
  }
}

// ========== MOCK TEST API ROUTES ==========

// Admin: Upload PDF and create paper (legacy - kept for backward compatibility)
app.post('/api/admin/mock-tests/upload', authMiddleware, adminMiddleware, upload.single('pdf'), async (req, res) => {
  try {
    const { title, subject, department, semester, year, totalMarks, duration } = req.body;
    const paper = new MockTestPaper({
      title, subject, department, semester, year,
      totalMarks: Number(totalMarks) || 0,
      duration: Number(duration) || 60
    });
    if (req.file) {
      const gridfsId = await uploadBufferToGridFS(req.file.buffer, req.file.originalname);
      paper.pdfFiles = [{
        gridfsId,
        filename: req.file.originalname,
        originalName: req.file.originalname,
        uploadedAt: new Date()
      }];
    }
    await paper.save();

    res.status(201).json({
      message: 'Paper created. Upload more PYQ PDFs to this paper, then click Generate Questions.',
      paper
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload paper' });
  }
});

// Admin: Create a new paper (without PDF)
app.post('/api/admin/mock-tests/papers', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { title, subject, department, semester, year } = req.body;
    const paper = new MockTestPaper({
      title,
      subject,
      department,
      semester,
      year
    });
    await paper.save();
    res.status(201).json({ message: 'Paper created successfully. Upload PYQ PDFs to it.', paper });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create paper' });
  }
});

// Admin: Upload PDFs to an existing paper
app.post('/api/admin/mock-tests/:id/pdfs', authMiddleware, adminMiddleware, upload.array('pdfs', 10), async (req, res) => {
  try {
    const paper = await MockTestPaper.findById(req.params.id);
    if (!paper) return res.status(404).json({ error: 'Paper not found' });

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No PDF files uploaded' });
    }

    const newFiles = [];
    for (const file of req.files) {
      const gridfsId = await uploadBufferToGridFS(file.buffer, file.originalname);
      newFiles.push({
        gridfsId,
        filename: file.originalname,
        originalName: file.originalname,
        uploadedAt: new Date()
      });
    }

    paper.pdfFiles = paper.pdfFiles || [];
    paper.pdfFiles.push(...newFiles);

    await paper.save();
    res.json({
      message: `${req.files.length} PDF(s) uploaded successfully.`,
      paper,
      pdfCount: paper.pdfFiles.length
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload PDFs' });
  }
});

// Admin: Upload Syllabus PDFs to an existing paper
app.post('/api/admin/mock-tests/:id/syllabus', authMiddleware, adminMiddleware, upload.array('syllabus', 5), async (req, res) => {
  try {
    const paper = await MockTestPaper.findById(req.params.id);
    if (!paper) return res.status(404).json({ error: 'Paper not found' });

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No syllabus PDF files uploaded' });
    }

    const newFiles = [];
    const buffers = [];
    for (const file of req.files) {
      const gridfsId = await uploadBufferToGridFS(file.buffer, file.originalname);
      newFiles.push({
        gridfsId,
        filename: file.originalname,
        originalName: file.originalname,
        uploadedAt: new Date()
      });
      buffers.push(file.buffer);
    }

    paper.syllabusFiles = paper.syllabusFiles || [];
    paper.syllabusFiles.push(...newFiles);

    // Extract and cache syllabus text
    const syllabusTexts = await extractTextFromBuffers(req.files.map(f => f.buffer));
    if (syllabusTexts.length > 0) {
      const existingText = paper.syllabusText || '';
      const newText = syllabusTexts.join('\n\n---\n\n');
      paper.syllabusText = existingText ? existingText + '\n\n---\n\n' + newText : newText;
    }

    await paper.save();
    res.json({
      message: `${req.files.length} syllabus PDF(s) uploaded successfully.`,
      syllabusCount: paper.syllabusFiles.length
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload syllabus PDFs' });
  }
});

// Admin: Upload PDF and create paper (legacy - kept for backward compatibility)
app.post('/api/admin/mock-tests/upload', authMiddleware, adminMiddleware, upload.single('pdf'), async (req, res) => {
  try {
    const { title, subject, department, semester, year, totalMarks, duration } = req.body;
    const paper = new MockTestPaper({
      title, subject, department, semester, year,
      totalMarks: Number(totalMarks) || 0,
      duration: Number(duration) || 60
    });
    if (req.file) {
      const gridfsId = await uploadBufferToGridFS(req.file.buffer, req.file.originalname);
      paper.pdfFiles = [{
        gridfsId,
        filename: req.file.originalname,
        originalName: req.file.originalname,
        uploadedAt: new Date()
      }];
    }
    await paper.save();

    res.status(201).json({
      message: 'Paper created. Upload more PYQ PDFs to this paper, then click Generate Questions.',
      paper
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload paper' });
  }
});

// Admin: Add questions to a paper
app.post('/api/admin/mock-tests/:id/questions', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const paper = await MockTestPaper.findById(req.params.id);
    if (!paper) return res.status(404).json({ error: 'Paper not found' });

    const questions = req.body.questions;
    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'Questions array required' });
    }

    const docs = questions.map(q => ({
      paperId: paper._id,
      question: q.question,
      options: q.options,
      correctAnswer: q.correctAnswer,
      marks: q.marks || 1,
      difficulty: q.difficulty || 'medium',
      topic: q.topic || ''
    }));

    await MockQuestion.insertMany(docs);
    const count = await MockQuestion.countDocuments({ paperId: paper._id });
    const totalMarks = await MockQuestion.aggregate([
      { $match: { paperId: paper._id } },
      { $group: { _id: null, total: { $sum: '$marks' } } }
    ]);

    paper.totalQuestions = count;
    paper.totalMarks = totalMarks.length > 0 ? totalMarks[0].total : 0;
    await paper.save();

    res.json({ success: true, totalQuestions: count, totalMarks: paper.totalMarks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add questions' });
  }
});

// Admin: Check AI configuration status
app.get('/api/admin/ai-status', authMiddleware, adminMiddleware, (req, res) => {
  res.json({
    aiEnabled,
    apiBase: AI_API_BASE,
    model: AI_MODEL,
    message: aiEnabled
      ? 'AI API is configured. Ready to generate questions from uploaded PDFs.'
      : 'AI API key not configured. Please set AI_API_KEY and AI_API_BASE (e.g., https://api.groq.com/openai/v1) in environment variables to enable question generation.'
  });
});
app.get('/api/admin/mock-tests', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const papers = await MockTestPaper.find().sort({ createdAt: -1 }).select('-__v');
    res.json(papers);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Delete a paper
app.delete('/api/admin/mock-tests/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await MockQuestion.deleteMany({ paperId: req.params.id });
    await MockTestResult.deleteMany({ paperId: req.params.id });
    const paper = await MockTestPaper.findByIdAndDelete(req.params.id);
    if (!paper) return res.status(404).json({ error: 'Paper not found' });

    // Delete all associated PDF files from GridFS and disk
    if (paper.pdfFiles && paper.pdfFiles.length > 0) {
      for (const pdf of paper.pdfFiles) {
        if (pdf.gridfsId) {
          try { await deleteFromGridFS(pdf.gridfsId); } catch (e) { /* ignore */ }
        }
        if (pdf.path && fs.existsSync(pdf.path)) {
          try { fs.unlinkSync(pdf.path); } catch (e) { /* ignore */ }
        }
      }
    }
    if (paper.pdfFilePath && fs.existsSync(paper.pdfFilePath)) {
      try { fs.unlinkSync(paper.pdfFilePath); } catch (e) { /* ignore */ }
    }
    // Delete syllabus files from GridFS and disk
    if (paper.syllabusFiles && paper.syllabusFiles.length > 0) {
      for (const pdf of paper.syllabusFiles) {
        if (pdf.gridfsId) {
          try { await deleteFromGridFS(pdf.gridfsId); } catch (e) { /* ignore */ }
        }
        if (pdf.path && fs.existsSync(pdf.path)) {
          try { fs.unlinkSync(pdf.path); } catch (e) { /* ignore */ }
        }
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Get questions for a paper
app.get('/api/admin/mock-tests/:id/questions', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const questions = await MockQuestion.find({ paperId: req.params.id }).select('-__v');
    res.json(questions);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Generate questions from all PDFs for a paper
app.post('/api/admin/mock-tests/:id/generate', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const paper = await MockTestPaper.findById(req.params.id);
    if (!paper) return res.status(404).json({ error: 'Paper not found' });

    const result = await generateQuestionsFromPaper(paper);
    if (result.success) {
      res.json({
        success: true,
        message: `AI generated ${result.count} questions from ${paper.pdfFiles?.length || 1} PDF(s). Total marks: ${result.totalMarks}`,
        count: result.count,
        totalMarks: result.totalMarks
      });
    } else {
      res.status(500).json({ error: result.error || 'Question generation failed' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during question generation' });
  }
});

// User: Upload a descriptive answer file (handwritten paper scanned as PDF or image)
app.post('/api/mock-tests/:id/upload-answer', authMiddleware, upload.single('answerFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const allowedMimeTypes = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg'];
    if (!allowedMimeTypes.includes(req.file.mimetype)) {
      return res.status(400).json({ error: 'Only PDF, PNG, or JPG files are allowed' });
    }
    const maxSize = 5 * 1024 * 1024; // 5 MB
    if (req.file.size > maxSize) {
      return res.status(400).json({ error: 'File size exceeds 5 MB limit' });
    }
    const gridfsId = await uploadBufferToGridFS(req.file.buffer, req.file.originalname);
    res.json({ success: true, fileId: gridfsId.toString(), fileName: req.file.originalname });
  } catch (err) {
    console.error('Upload answer error:', err);
    res.status(500).json({ error: 'Failed to upload answer file' });
  }
});

// User: Get an uploaded answer file
app.get('/api/answer-files/:fileId', authMiddleware, async (req, res) => {
  try {
    const buffer = await downloadFromGridFS(req.params.fileId);
    res.set('Content-Type', 'application/octet-stream');
    res.send(buffer);
  } catch (err) {
    res.status(404).json({ error: 'File not found' });
  }
});

// User: List available papers (any paper with at least one PDF)
app.get('/api/mock-tests/papers', authMiddleware, async (req, res) => {
  try {
    const papers = await MockTestPaper.find({ status: 'active' }).select('-__v');
    // Only return papers that have at least one PDF (new pdfFiles or legacy pdfUrl)
    const available = papers.filter(p => {
      if (p.pdfFiles && p.pdfFiles.length > 0) return true;
      if (p.pdfUrl || p.pdfFilePath) return true;
      return false;
    });
    res.json(available);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// User: Start a test — generates questions from PDFs on demand using AI
app.post('/api/mock-tests/:id/start', authMiddleware, async (req, res) => {
  try {
    const paper = await MockTestPaper.findById(req.params.id);
    if (!paper) return res.status(404).json({ error: 'Paper not found' });

    const { marks, duration, questionType } = req.body;
    const totalMarks = Number(marks) || 30;
    const testDuration = Number(duration) || 60;
    const qType = ['mcq', 'descriptive', 'mixed'].includes(questionType) ? questionType : 'mcq';

    if (!aiEnabled) {
      return res.status(400).json({ error: 'AI is not configured on this server. Please contact admin.' });
    }

    // Extract text from all PDFs (PYQs + syllabus)
    const { pyqText, syllabusText } = await getPaperTexts(paper);
    if (!pyqText) {
      return res.status(400).json({ error: 'No PYQ text found for this paper.' });
    }

    let combinedPyqText = pyqText;
    const MAX_CHARS = 12000;
    if (combinedPyqText.length > MAX_CHARS) {
      combinedPyqText = combinedPyqText.substring(0, MAX_CHARS) + '\n\n[Additional PYQ content truncated...]';
    }

    // Fetch user's previous result for this paper to adjust difficulty
    let targetDifficulty = 'medium';
    try {
      const previousResult = await MockTestResult.findOne({
        userId: req.user.id,
        paperId: req.params.id
      }).sort({ completedAt: -1 });
      if (previousResult && previousResult.totalMarks > 0) {
        const percentage = (previousResult.score / previousResult.totalMarks) * 100;
        targetDifficulty = getTargetDifficulty(percentage);
        console.log(`[Adaptive Difficulty] User ${req.user.id} previous score: ${percentage.toFixed(1)}% → ${targetDifficulty}`);
      }
    } catch (err) {
      console.error('Error fetching previous result for adaptive difficulty:', err.message);
    }

    const prompt = buildAIPrompt(qType, paper, totalMarks, testDuration, combinedPyqText, syllabusText, targetDifficulty);

    const aiResponse = await callAI(prompt);
    if (!aiResponse) {
      return res.status(500).json({ error: 'AI generation failed. Please check AI configuration or try again.' });
    }

    // Clean up response
    let cleanedResponse = aiResponse.trim();
    if (cleanedResponse.startsWith('```json')) {
      cleanedResponse = cleanedResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleanedResponse.startsWith('```')) {
      cleanedResponse = cleanedResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }
    cleanedResponse = cleanedResponse.trim();

    let rawQuestions;
    try {
      rawQuestions = JSON.parse(cleanedResponse);
    } catch (parseErr) {
      console.error('AI JSON parse error:', parseErr.message);
      return res.status(500).json({ error: 'AI returned invalid format. Please try again.' });
    }

    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
      return res.status(500).json({ error: 'AI generated no questions. Please try again.' });
    }

    // Validate and store
    const questions = [];
    let actualTotalMarks = 0;
    for (const q of rawQuestions) {
      if (!q.question) continue;
      const itemType = q.type === 'descriptive' ? 'descriptive' : 'mcq';
      if (itemType === 'mcq') {
        if (!Array.isArray(q.options) || q.options.length !== 4) continue;
        if (typeof q.correctAnswer !== 'number' || q.correctAnswer < 0 || q.correctAnswer > 3) continue;
      } else {
        if (!Array.isArray(q.options)) q.options = [];
      }
      const qMarks = Number(q.marks) || 1;
      questions.push({
        question: q.question.trim(),
        options: Array.isArray(q.options) ? q.options.map(o => String(o).trim()) : [],
        correctAnswer: itemType === 'descriptive' ? -1 : Math.round(q.correctAnswer),
        modelAnswer: q.modelAnswer || '',
        marks: qMarks,
        difficulty: ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : 'medium',
        topic: q.topic || '',
        type: itemType
      });
      actualTotalMarks += qMarks;
    }

    if (questions.length === 0) {
      return res.status(500).json({ error: 'No valid questions generated. Please try again.' });
    }

    // Create ephemeral session
    const session = new TestSession({
      paperId: paper._id,
      userId: req.user.id,
      questionType: qType,
      questions,
      totalMarks: actualTotalMarks,
      duration: testDuration
    });
    await session.save();

    // Return questions without correct answers to client
    const clientQuestions = questions.map((q, idx) => ({
      id: idx,
      question: q.question,
      options: q.options,
      marks: q.marks,
      difficulty: q.difficulty,
      topic: q.topic,
      type: q.type
    }));

    res.json({
      testId: session._id,
      paper: { title: paper.title, subject: paper.subject, department: paper.department, semester: paper.semester },
      questions: clientQuestions,
      totalMarks: actualTotalMarks,
      duration: testDuration,
      questionCount: questions.length,
      questionType: qType
    });
  } catch (err) {
    console.error('Start test error:', err);
    res.status(500).json({ error: 'Server error during test generation' });
  }
});

// User: Submit test (uses ephemeral TestSession)
app.post('/api/mock-tests/:id/submit', authMiddleware, async (req, res) => {
  try {
    const { testId, answers, timeTaken } = req.body;
    if (!testId) return res.status(400).json({ error: 'Test ID required' });

    const session = await TestSession.findById(testId);
    if (!session) return res.status(400).json({ error: 'Test session expired or not found. Please start a new test.' });

    const questions = session.questions;
    const userAnswers = answers || [];

    let score = 0, correct = 0, wrong = 0, unanswered = 0, descriptiveCount = 0;
    const answerMap = {};
    const textAnswerMap = {};
    const fileAnswerMap = {};
    userAnswers.forEach(a => {
      answerMap[a.questionId] = a.selectedOption;
      if (a.textAnswer !== undefined && a.textAnswer !== null) {
        textAnswerMap[a.questionId] = a.textAnswer;
      }
      if (a.fileId) {
        fileAnswerMap[a.questionId] = { fileId: a.fileId, fileName: a.fileName || '' };
      }
    });

    const detailedResults = questions.map((q, idx) => {
      if (q.type === 'descriptive') {
        const fileAnswer = fileAnswerMap[idx];
        const textAnswer = textAnswerMap[idx] || '';
        const isUnanswered = !fileAnswer && (!textAnswer || textAnswer.trim() === '');
        if (isUnanswered) unanswered++;
        else descriptiveCount++;
        return {
          questionId: idx,
          question: q.question,
          options: q.options,
          correctAnswer: q.correctAnswer,
          modelAnswer: q.modelAnswer || '',
          selectedOption: -1,
          textAnswer,
          fileId: fileAnswer ? fileAnswer.fileId : null,
          fileName: fileAnswer ? fileAnswer.fileName : null,
          isCorrect: null,
          marks: q.marks,
          type: 'descriptive'
        };
      }
      const selected = answerMap[idx];
      const isCorrect = selected === q.correctAnswer;
      const isUnanswered = selected === undefined || selected === null;

      if (isCorrect) { score += q.marks; correct++; }
      else if (isUnanswered) { unanswered++; }
      else { wrong++; }

      return {
        questionId: idx,
        question: q.question,
        options: q.options,
        correctAnswer: q.correctAnswer,
        modelAnswer: q.modelAnswer || '',
        selectedOption: selected,
        textAnswer: '',
        isCorrect,
        marks: q.marks,
        type: 'mcq'
      };
    });

    const result = new MockTestResult({
      userId: req.user.id,
      paperId: req.params.id,
      answers: userAnswers.map(a => ({
        questionId: a.questionId,
        selectedOption: a.selectedOption,
        textAnswer: a.textAnswer || '',
        fileId: a.fileId || '',
        fileName: a.fileName || ''
      })),
      score,
      totalMarks: session.totalMarks,
      correctCount: correct,
      wrongCount: wrong,
      unansweredCount: unanswered,
      timeTaken: timeTaken || 0
    });
    await result.save();

    // Clean up session
    await TestSession.findByIdAndDelete(testId);

    res.json({
      score,
      totalMarks: session.totalMarks,
      correctCount: correct,
      wrongCount: wrong,
      unansweredCount: unanswered,
      timeTaken: timeTaken || 0,
      percentage: session.totalMarks > 0 ? ((score / session.totalMarks) * 100).toFixed(2) : '0.00',
      detailedResults
    });
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// User: Get test results
app.get('/api/mock-tests/results', authMiddleware, async (req, res) => {
  try {
    const results = await MockTestResult.find({ userId: req.user.id })
      .populate('paperId', 'title subject department semester')
      .sort({ completedAt: -1 });
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// User: Get previous result for a specific paper (used for adaptive difficulty)
app.get('/api/mock-tests/:id/previous-result', authMiddleware, async (req, res) => {
  try {
    const previousResult = await MockTestResult.findOne({
      userId: req.user.id,
      paperId: req.params.id
    }).sort({ completedAt: -1 });
    if (!previousResult) {
      return res.json({ hasPreviousResult: false });
    }
    const percentage = previousResult.totalMarks > 0
      ? ((previousResult.score / previousResult.totalMarks) * 100)
      : 0;
    const targetDifficulty = getTargetDifficulty(percentage);
    res.json({
      hasPreviousResult: true,
      score: previousResult.score,
      totalMarks: previousResult.totalMarks,
      percentage: Number(percentage.toFixed(1)),
      targetDifficulty,
      completedAt: previousResult.completedAt
    });
  } catch (err) {
    console.error('Previous result fetch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ========== COMPETITIVE EXAM MOCK TEST ROUTES ==========

// Admin: Get all competitive exam configs
app.get('/api/admin/competitive-exams', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const configs = await CompetitiveExamConfig.find().sort({ examName: 1 }).select('-__v');
    res.json(configs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Create or update a competitive exam config
app.post('/api/admin/competitive-exams', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { examName, displayName, duration, totalMarks } = req.body;
    if (!['NEET', 'JEE', 'GATE', 'WBJEE'].includes(examName)) {
      return res.status(400).json({ error: 'Invalid exam name. Must be NEET, JEE, GATE, or WBJEE.' });
    }
    let config = await CompetitiveExamConfig.findOne({ examName });
    if (config) {
      config.displayName = displayName || config.displayName;
      config.duration = duration || config.duration;
      config.totalMarks = totalMarks || config.totalMarks;
      config.updatedAt = new Date();
    } else {
      config = new CompetitiveExamConfig({
        examName,
        displayName: displayName || examName,
        duration: duration || 180,
        totalMarks: totalMarks || 300
      });
    }
    await config.save();
    res.json({ success: true, config });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Upload PYQ PDFs for a competitive exam
app.post('/api/admin/competitive-exams/:examName/pyq', authMiddleware, adminMiddleware, upload.array('pyq', 10), async (req, res) => {
  try {
    const { examName } = req.params;
    if (!['NEET', 'JEE', 'GATE', 'WBJEE'].includes(examName)) {
      return res.status(400).json({ error: 'Invalid exam name' });
    }
    const config = await CompetitiveExamConfig.findOne({ examName });
    if (!config) return res.status(404).json({ error: 'Exam config not found. Create it first.' });
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No PDF files uploaded' });
    }

    const newFiles = [];
    const buffers = [];
    for (const file of req.files) {
      const gridfsId = await uploadBufferToGridFS(file.buffer, file.originalname);
      newFiles.push({ gridfsId, filename: file.originalname, originalName: file.originalname, uploadedAt: new Date() });
      buffers.push(file.buffer);
    }
    config.pyqFiles = config.pyqFiles || [];
    config.pyqFiles.push(...newFiles);

    // Extract and cache text
    const texts = await extractTextFromBuffers(buffers);
    if (texts.length > 0) {
      const existingText = config.pyqText || '';
      const newText = texts.join('\n\n---\n\n');
      config.pyqText = existingText ? existingText + '\n\n---\n\n' + newText : newText;
    }
    config.updatedAt = new Date();
    await config.save();

    res.json({ message: `${req.files.length} PYQ PDF(s) uploaded successfully.`, pyqCount: config.pyqFiles.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload PYQ PDFs' });
  }
});

// Admin: Upload Syllabus PDFs for a competitive exam
app.post('/api/admin/competitive-exams/:examName/syllabus', authMiddleware, adminMiddleware, upload.array('syllabus', 5), async (req, res) => {
  try {
    const { examName } = req.params;
    if (!['NEET', 'JEE', 'GATE', 'WBJEE'].includes(examName)) {
      return res.status(400).json({ error: 'Invalid exam name' });
    }
    const config = await CompetitiveExamConfig.findOne({ examName });
    if (!config) return res.status(404).json({ error: 'Exam config not found. Create it first.' });
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No syllabus PDF files uploaded' });
    }

    const newFiles = [];
    const buffers = [];
    for (const file of req.files) {
      const gridfsId = await uploadBufferToGridFS(file.buffer, file.originalname);
      newFiles.push({ gridfsId, filename: file.originalname, originalName: file.originalname, uploadedAt: new Date() });
      buffers.push(file.buffer);
    }
    config.syllabusFiles = config.syllabusFiles || [];
    config.syllabusFiles.push(...newFiles);

    // Extract and cache text
    const texts = await extractTextFromBuffers(buffers);
    if (texts.length > 0) {
      const existingText = config.syllabusText || '';
      const newText = texts.join('\n\n---\n\n');
      config.syllabusText = existingText ? existingText + '\n\n---\n\n' + newText : newText;
    }
    config.updatedAt = new Date();
    await config.save();

    res.json({ message: `${req.files.length} syllabus PDF(s) uploaded successfully.`, syllabusCount: config.syllabusFiles.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload syllabus PDFs' });
  }
});

// Admin: Delete a competitive exam config (and its files)
app.delete('/api/admin/competitive-exams/:examName', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { examName } = req.params;
    const config = await CompetitiveExamConfig.findOne({ examName });
    if (!config) return res.status(404).json({ error: 'Exam config not found' });

    // Delete associated GridFS files
    if (config.pyqFiles) {
      for (const f of config.pyqFiles) {
        if (f.gridfsId) try { await deleteFromGridFS(f.gridfsId); } catch (e) { /* ignore */ }
      }
    }
    if (config.syllabusFiles) {
      for (const f of config.syllabusFiles) {
        if (f.gridfsId) try { await deleteFromGridFS(f.gridfsId); } catch (e) { /* ignore */ }
      }
    }

    await CompetitiveTestResult.deleteMany({ examName });
    await CompetitiveExamConfig.deleteOne({ examName });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Check AI Mock configuration status
app.get('/api/admin/ai-mock-status', authMiddleware, adminMiddleware, (req, res) => {
  res.json({
    geminiEnabled,
    geminiModel: GEMINI_MODEL,
    groqKeys: AI_API_MOCK_KEYS.length,
    aiMockEnabled,
    message: geminiEnabled
      ? `Gemini AI (${GEMINI_MODEL}) connected. 1M TPM free tier — fast generation with no rate limits.`
      : (AI_API_MOCK_KEYS.length > 0
        ? `Groq fallback only (${AI_API_MOCK_KEYS.length} key(s)). Limited to ~12K TPM — slow generation.`
        : 'No AI keys configured. Set GEMINI_API_KEY for Google AI Studio, or AI_API_MOCK1..10 for Groq.')
  });
});

// User: List available competitive exams (return all active configs, frontend decides availability)
app.get('/api/competitive-exams', authMiddleware, async (req, res) => {
  try {
    const configs = await CompetitiveExamConfig.find({ status: 'active' }).select('-__v').sort({ examName: 1 });
    res.json(configs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// User: Start a competitive mock test
app.post('/api/competitive-exams/:examName/start', authMiddleware, async (req, res) => {
  try {
    const { examName } = req.params;
    if (!['NEET', 'JEE', 'GATE', 'WBJEE'].includes(examName)) {
      return res.status(400).json({ error: 'Invalid exam name' });
    }
    const config = await CompetitiveExamConfig.findOne({ examName, status: 'active' });
    if (!config) return res.status(404).json({ error: 'Exam not found or not active' });

    const { marks, duration } = req.body;
    const totalMarks = Number(marks) || config.totalMarks || 300;
    const testDuration = Number(duration) || config.duration || 180;

    if (!aiMockEnabled) {
      return res.status(400).json({ error: 'AI Mock is not configured on this server. Please contact admin.' });
    }

    const result = await generateCompetitiveQuestionsFromExam(config, totalMarks, testDuration);
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Question generation failed' });
    }

    const questions = result.questions;
    let actualTotalMarks = 0;
    for (const q of questions) actualTotalMarks += q.marks;

    // Create ephemeral session
    const session = new CompetitiveTestSession({
      examName,
      userId: req.user.id,
      questions,
      totalMarks: actualTotalMarks,
      duration: testDuration
    });
    await session.save();

    // Return questions without correct answers
    const clientQuestions = questions.map((q, idx) => ({
      id: idx,
      question: q.question,
      options: q.options,
      marks: q.marks,
      difficulty: q.difficulty,
      topic: q.topic,
      type: q.type
    }));

    res.json({
      testId: session._id,
      examName: config.displayName || examName,
      questions: clientQuestions,
      totalMarks: actualTotalMarks,
      duration: testDuration,
      questionCount: questions.length
    });
  } catch (err) {
    console.error('Start competitive test error:', err);
    res.status(500).json({ error: 'Server error during test generation' });
  }
});

// User: Submit competitive test
app.post('/api/competitive-exams/:examName/submit', authMiddleware, async (req, res) => {
  try {
    const { testId, answers, timeTaken } = req.body;
    if (!testId) return res.status(400).json({ error: 'Test ID required' });

    const session = await CompetitiveTestSession.findById(testId);
    if (!session) return res.status(400).json({ error: 'Test session expired or not found. Please start a new test.' });

    const questions = session.questions;
    const userAnswers = answers || [];

    let score = 0, correct = 0, wrong = 0, unanswered = 0;
    const answerMap = {};
    userAnswers.forEach(a => { answerMap[a.questionId] = a.selectedOption; });

    const detailedResults = questions.map((q, idx) => {
      const selected = answerMap[idx];
      const isCorrect = selected === q.correctAnswer;
      const isUnanswered = selected === undefined || selected === null;

      if (isCorrect) { score += q.marks; correct++; }
      else if (isUnanswered) { unanswered++; }
      else { wrong++; }

      return {
        questionId: idx,
        question: q.question,
        options: q.options,
        correctAnswer: q.correctAnswer,
        modelAnswer: q.modelAnswer || '',
        selectedOption: selected,
        isCorrect,
        marks: q.marks,
        type: 'mcq'
      };
    });

    const result = new CompetitiveTestResult({
      userId: req.user.id,
      examName: session.examName,
      answers: userAnswers.map(a => ({
        questionId: a.questionId,
        selectedOption: a.selectedOption
      })),
      score,
      totalMarks: session.totalMarks,
      correctCount: correct,
      wrongCount: wrong,
      unansweredCount: unanswered,
      timeTaken: timeTaken || 0
    });
    await result.save();

    // Clean up session
    await CompetitiveTestSession.findByIdAndDelete(testId);

    res.json({
      score,
      totalMarks: session.totalMarks,
      correctCount: correct,
      wrongCount: wrong,
      unansweredCount: unanswered,
      timeTaken: timeTaken || 0,
      percentage: session.totalMarks > 0 ? ((score / session.totalMarks) * 100).toFixed(2) : '0.00',
      detailedResults
    });
  } catch (err) {
    console.error('Submit competitive test error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// User: Get competitive test results
app.get('/api/competitive-exams/results', authMiddleware, async (req, res) => {
  try {
    const results = await CompetitiveTestResult.find({ userId: req.user.id })
      .sort({ completedAt: -1 });
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// User: Get competitive results for a specific exam
app.get('/api/competitive-exams/:examName/results', authMiddleware, async (req, res) => {
  try {
    const results = await CompetitiveTestResult.find({
      userId: req.user.id,
      examName: req.params.examName
    }).sort({ completedAt: -1 });
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Serve files from GridFS (replaces /uploads static route for GridFS-stored files)
app.get('/api/files/:gridfsId', async (req, res) => {
  try {
    const fileId = req.params.gridfsId;
    const buffer = await downloadFromGridFS(fileId);
    res.set('Content-Type', 'application/pdf');
    res.send(buffer);
  } catch (err) {
    res.status(404).json({ error: 'File not found' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
