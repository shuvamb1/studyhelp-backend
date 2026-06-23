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
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_API_BASE = process.env.AI_API_BASE || 'https://api.openai.com/v1';
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';
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

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

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
  totalQuestions: { type: Number, default: 0 },
  totalMarks: { type: Number, default: 0 },
  pdfUrl: String,
  pdfFilePath: String,
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
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student' },
  paperId: { type: mongoose.Schema.Types.ObjectId, ref: 'MockTestPaper' },
  answers: [{ questionId: mongoose.Schema.Types.ObjectId, selectedOption: Number }],
  score: Number,
  totalMarks: Number,
  correctCount: Number,
  wrongCount: Number,
  unansweredCount: Number,
  timeTaken: Number,
  completedAt: { type: Date, default: Date.now }
});
const MockTestResult = mongoose.model('MockTestResult', mockTestResultSchema);

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
          { role: 'system', content: 'You are an expert exam question generator. You generate multiple-choice questions from exam papers. You always respond with valid JSON only, no markdown, no explanations, no code blocks.' },
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

async function generateQuestionsFromPDF(paperId, pdfPath, title, subject) {
  try {
    if (!fs.existsSync(pdfPath)) {
      console.error('PDF file not found:', pdfPath);
      return { success: false, error: 'PDF file not found' };
    }

    const pdfBuffer = fs.readFileSync(pdfPath);
    const pdfData = await pdfParse(pdfBuffer);
    let text = pdfData.text || '';

    if (!text.trim()) {
      return { success: false, error: 'Could not extract text from PDF. The PDF may be scanned/image-based.' };
    }

    // Truncate if too long (approx 8000 chars to stay within token limits)
    const MAX_CHARS = 8000;
    if (text.length > MAX_CHARS) {
      text = text.substring(0, MAX_CHARS) + '\n\n[Content truncated due to length...]';
    }

    const prompt = `You are an expert exam question generator. I will give you the text content of a previous year exam paper (PYQ). Your task is to generate multiple-choice questions based on this paper.

EXAM DETAILS:
Title: ${title}
Subject: ${subject}

INSTRUCTIONS:
1. Read through the entire paper content carefully.
2. Generate multiple-choice questions. Aim for 10-25 questions depending on the paper length and content richness.
3. For each question:
   - Include some EXACT same questions from the paper if they are suitable as multiple-choice questions
   - Also create NEW similar questions that test the same concepts and topics
   - Each question must have exactly 4 options (A, B, C, D)
   - Mark the correct answer with a 0-based index (0=A, 1=B, 2=C, 3=D)
   - Assign marks: typically 1 mark per question, 2 marks for more complex questions
   - Include difficulty level: easy, medium, or hard
   - Include a topic tag for the question
4. Ensure questions cover ALL major topics in the paper
5. Return ONLY a valid JSON array with NO markdown formatting, NO code blocks, NO explanation text outside the JSON

PAPER CONTENT:
${text}

JSON FORMAT (return ONLY this, no other text):
[
  {
    "question": "Question text here",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctAnswer": 0,
    "marks": 1,
    "difficulty": "medium",
    "topic": "topic name"
  }
]`;

    const aiResponse = await callAI(prompt);
    if (!aiResponse) {
      return { success: false, error: 'AI generation failed or AI API not configured.' };
    }

    // Clean up response - extract JSON from possible markdown code blocks
    let cleanedResponse = aiResponse.trim();
    if (cleanedResponse.startsWith('```json')) {
      cleanedResponse = cleanedResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleanedResponse.startsWith('```')) {
      cleanedResponse = cleanedResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }
    cleanedResponse = cleanedResponse.trim();

    let questions;
    try {
      questions = JSON.parse(cleanedResponse);
    } catch (parseErr) {
      console.error('AI JSON parse error:', parseErr.message, 'Raw response:', cleanedResponse.substring(0, 500));
      return { success: false, error: 'AI returned invalid JSON format.' };
    }

    if (!Array.isArray(questions) || questions.length === 0) {
      return { success: false, error: 'AI generated no valid questions.' };
    }

    // Validate and normalize each question
    const validQuestions = [];
    for (const q of questions) {
      if (!q.question || !Array.isArray(q.options) || q.options.length !== 4) continue;
      if (typeof q.correctAnswer !== 'number' || q.correctAnswer < 0 || q.correctAnswer > 3) continue;
      validQuestions.push({
        paperId: new mongoose.Types.ObjectId(paperId),
        question: q.question.trim(),
        options: q.options.map(o => String(o).trim()),
        correctAnswer: Math.round(q.correctAnswer),
        marks: Number(q.marks) || 1,
        difficulty: ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : 'medium',
        topic: q.topic || ''
      });
    }

    if (validQuestions.length === 0) {
      return { success: false, error: 'No valid questions after validation.' };
    }

    // Delete existing questions for this paper before saving new ones
    await MockQuestion.deleteMany({ paperId: new mongoose.Types.ObjectId(paperId) });
    await MockQuestion.insertMany(validQuestions);

    // Update paper totals
    const count = await MockQuestion.countDocuments({ paperId: new mongoose.Types.ObjectId(paperId) });
    const totalMarksResult = await MockQuestion.aggregate([
      { $match: { paperId: new mongoose.Types.ObjectId(paperId) } },
      { $group: { _id: null, total: { $sum: '$marks' } } }
    ]);

    await MockTestPaper.findByIdAndUpdate(paperId, {
      totalQuestions: count,
      totalMarks: totalMarksResult.length > 0 ? totalMarksResult[0].total : 0
    });

    return { success: true, count: validQuestions.length, totalMarks: totalMarksResult.length > 0 ? totalMarksResult[0].total : 0 };
  } catch (err) {
    console.error('generateQuestionsFromPDF error:', err);
    return { success: false, error: err.message };
  }
}

// ========== MOCK TEST API ROUTES ==========

// Admin: Upload PDF and create paper (auto-generates questions via AI)
app.post('/api/admin/mock-tests/upload', authMiddleware, adminMiddleware, upload.single('pdf'), async (req, res) => {
  try {
    const { title, subject, department, semester, year, duration } = req.body;
    const paper = new MockTestPaper({
      title, subject, department, semester, year,
      duration: Number(duration) || 60,
      pdfFilePath: req.file ? req.file.path : '',
      pdfUrl: req.file ? `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}` : ''
    });
    await paper.save();

    // Trigger AI question generation in the background
    if (req.file && aiEnabled) {
      generateQuestionsFromPDF(paper._id, req.file.path, title, subject)
        .then(result => {
          if (result.success) {
            console.log(`AI generated ${result.count} questions for paper ${paper._id}`);
          } else {
            console.error(`AI generation failed for paper ${paper._id}:`, result.error);
          }
        })
        .catch(err => console.error('AI generation error:', err));
    }

    res.status(201).json({
      message: aiEnabled
        ? 'Paper uploaded. AI is generating questions in the background. Refresh in a moment to see them.'
        : 'Paper uploaded. Please add questions manually or set up AI_API_KEY for automatic generation.',
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

// Admin: List all papers
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

// Admin: Regenerate questions with AI
app.post('/api/admin/mock-tests/:id/generate', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const paper = await MockTestPaper.findById(req.params.id);
    if (!paper) return res.status(404).json({ error: 'Paper not found' });
    if (!paper.pdfFilePath || !fs.existsSync(paper.pdfFilePath)) {
      return res.status(400).json({ error: 'PDF file not available for this paper' });
    }
    if (!aiEnabled) {
      return res.status(400).json({ error: 'AI API not configured. Please set AI_API_KEY in environment variables.' });
    }

    const result = await generateQuestionsFromPDF(paper._id, paper.pdfFilePath, paper.title, paper.subject);
    if (result.success) {
      res.json({ success: true, message: `AI generated ${result.count} questions. Total marks: ${result.totalMarks}`, count: result.count, totalMarks: result.totalMarks });
    } else {
      res.status(500).json({ error: result.error || 'AI generation failed' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during AI generation' });
  }
});

// User: List available papers
app.get('/api/mock-tests/papers', authMiddleware, async (req, res) => {
  try {
    const papers = await MockTestPaper.find({ status: 'active', totalQuestions: { $gt: 0 } }).select('-__v');
    res.json(papers);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// User: Get questions for a paper (randomized, for test)
app.get('/api/mock-tests/:id/questions', authMiddleware, async (req, res) => {
  try {
    const paper = await MockTestPaper.findById(req.params.id);
    if (!paper) return res.status(404).json({ error: 'Paper not found' });

    const questions = await MockQuestion.find({ paperId: req.params.id }).select('-correctAnswer -__v');
    // Shuffle questions
    const shuffled = questions.sort(() => 0.5 - Math.random());
    res.json({ paper, questions: shuffled });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// User: Submit test
app.post('/api/mock-tests/:id/submit', authMiddleware, async (req, res) => {
  try {
    const paper = await MockTestPaper.findById(req.params.id);
    if (!paper) return res.status(404).json({ error: 'Paper not found' });

    const questions = await MockQuestion.find({ paperId: req.params.id });
    const answers = req.body.answers || [];

    let score = 0, correct = 0, wrong = 0, unanswered = 0;

    const answerMap = {};
    answers.forEach(a => { answerMap[a.questionId] = a.selectedOption; });

    const detailedResults = questions.map(q => {
      const selected = answerMap[q._id.toString()];
      const isCorrect = selected === q.correctAnswer;
      const isUnanswered = selected === undefined || selected === null;

      if (isCorrect) { score += q.marks; correct++; }
      else if (isUnanswered) { unanswered++; }
      else { wrong++; }

      return {
        questionId: q._id,
        question: q.question,
        options: q.options,
        correctAnswer: q.correctAnswer,
        selectedOption: selected,
        isCorrect,
        marks: q.marks
      };
    });

    const result = new MockTestResult({
      userId: req.user.id,
      paperId: req.params.id,
      answers: answers.map(a => ({ questionId: a.questionId, selectedOption: a.selectedOption })),
      score,
      totalMarks: paper.totalMarks,
      correctCount: correct,
      wrongCount: wrong,
      unansweredCount: unanswered,
      timeTaken: req.body.timeTaken || 0
    });
    await result.save();

    res.json({
      score, totalMarks: paper.totalMarks, correctCount: correct, wrongCount: wrong, unansweredCount: unanswered,
      timeTaken: req.body.timeTaken || 0, percentage: ((score / paper.totalMarks) * 100).toFixed(2),
      detailedResults
    });
  } catch (err) {
    console.error(err);
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
