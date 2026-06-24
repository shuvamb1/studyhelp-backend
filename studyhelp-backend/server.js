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

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB Atlas'))
  .catch((err) => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

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
  answers: [{ questionId: { type: mongoose.Schema.Types.Mixed }, selectedOption: Number, textAnswer: String }],
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

function buildAIPrompt(questionType, paper, totalMarks, testDuration, pyqText, syllabusText) {
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
3. Generate questions according to the syllabus content. The questions must be at the SAME DIFFICULTY LEVEL as the PYQs.
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

    const prompt = buildAIPrompt(qType, paper, totalMarks, testDuration, combinedPyqText, syllabusText);

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
    userAnswers.forEach(a => {
      answerMap[a.questionId] = a.selectedOption;
      if (a.textAnswer !== undefined && a.textAnswer !== null) {
        textAnswerMap[a.questionId] = a.textAnswer;
      }
    });

    const detailedResults = questions.map((q, idx) => {
      if (q.type === 'descriptive') {
        const textAnswer = textAnswerMap[idx] || '';
        const isUnanswered = !textAnswer || textAnswer.trim() === '';
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
        textAnswer: a.textAnswer || ''
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
