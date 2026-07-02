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

// ========== AI CONFIGURATION ==========
// OpenAI-compatible base (used by Groq)
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_API_BASE = process.env.AI_API_BASE || 'https://api.openai.com/v1';
const AI_MODEL = process.env.AI_MODEL || 'llama-3.3-70b-versatile';
const aiEnabled = !!AI_API_KEY;

// Competitive Mock Test: Groq keys (up to 10, each from a separate account for independent TPM limits)
const AI_API_MOCK_KEYS = [];
for (let i = 1; i <= 10; i++) {
  const key = process.env[`AI_API_MOCK${i}`];
  if (key) AI_API_MOCK_KEYS.push(key);
}
if (AI_API_MOCK_KEYS.length === 0) {
  const fallback = process.env.AI_API_MOCK || AI_API_KEY || '';
  if (fallback) AI_API_MOCK_KEYS.push(fallback);
}
const aiMockEnabled = AI_API_MOCK_KEYS.length > 0;
const MOCKS_PER_KEY = 2;          // how many requests per key before cooldown
const KEY_COOLDOWN_MS = 60000;    // 60s between uses of the same key
const PAUSE_BETWEEN_ROUNDS_MS = 60000; // 60s pause between parallel rounds (matches key cooldown to let TPM fully reset)
const RETRY_COOLDOWN_MS = 60000;  // 60s cooling time after each retrying batch

// Track per-key cooldown to respect each account's rate limit
const keyCooldowns = AI_API_MOCK_KEYS.map(() => 0);

function getAvailableKey() {
  const now = Date.now();
  for (let i = 0; i < AI_API_MOCK_KEYS.length; i++) {
    if (now >= keyCooldowns[i]) return i;
  }
  return -1; // all on cooldown
}
function markKeyUsed(keyIndex, customCooldownMs = KEY_COOLDOWN_MS) {
  keyCooldowns[keyIndex] = Date.now() + customCooldownMs;
}
function waitForAnyKey() {
  const earliest = Math.min(...keyCooldowns);
  const waitMs = earliest - Date.now();
  if (waitMs > 0) return delay(waitMs + 1000);
  return Promise.resolve();
}
function waitForKey(keyIndex) {
  const waitMs = keyCooldowns[keyIndex] - Date.now();
  if (waitMs > 0) return delay(waitMs + 1000);
  return Promise.resolve();
}

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB Atlas'))
  .catch((err) => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== GROQ API CALL (Competitive Mock) ==========
async function callGroqMock(prompt, apiKey, maxTokens = 4000) {
  if (!apiKey) {
    return { success: false, content: null };
  }
  try {
    const res = await fetch(`${AI_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: 'You are an expert competitive exam question setter. Generate tough, exam-level questions. Return valid JSON only — no markdown, no code blocks, no extra text outside the JSON array.' },
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
          const retryAfter = retryMatch ? parseFloat(retryMatch[1]) + 3 : 60;
          console.log(`[Competitive Mock] Rate limited. Retry after ${retryAfter}s`);
          return { success: false, retryAfter, content: null };
        }
      } catch (e) {}
      console.error('Groq API error:', errText);
      return { success: false, content: null };
    }
    
    const data = await res.json();
    return { success: true, content: data.choices?.[0]?.message?.content || null };
  } catch (err) {
    console.error('Groq call failed:', err);
    return { success: false, content: null };
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
      let text;
      if (file.gridfsId) {
        const stream = await gfs.openDownloadStream(file.gridfsId);
        const buffer = await streamToBuffer(stream);
        const pdfData = await pdfParse(buffer);
        text = pdfData.text;
      } else if (file.filePath) {
        const buffer = fs.readFileSync(file.filePath);
        const pdfData = await pdfParse(buffer);
        text = pdfData.text;
      } else if (file.filename && file.path) {
        const buffer = fs.readFileSync(file.path);
        const pdfData = await pdfParse(buffer);
        text = pdfData.text;
      }
      if (text && text.trim()) {
        texts.push(text.trim());
      }
    } catch (err) {
      console.error('File text extraction error:', err.message);
    }
  }
  return texts;
}

// Helper to convert stream to buffer
async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// ========== MONGOOSE SCHEMAS ==========

const studentSchema = new mongoose.Schema({
  name: String,
  roll: Number,
  department: String,
  year: String,
  cin: String,
  downloadsCount: { type: Number, default: 0 },
  contributionsCount: { type: Number, default: 0 },
  role: { type: String, default: 'user' }
}, { strict: false, collection: 'students' });
const Student = mongoose.model('Student', studentSchema);

// ========== MATERIALS SCHEMA ==========
const materialSchema = new mongoose.Schema({
  subject: String,
  department: String,
  semester: String,
  title: String,
  type: String,
  url: String,
  date: String
}, { strict: false, collection: 'materials' });
const Material = mongoose.model('Material', materialSchema);

// ========== NOTICE SCHEMA ==========
const noticeSchema = new mongoose.Schema({
  message: String,
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
}, { strict: false, collection: 'notices' });
const Notice = mongoose.model('Notice', noticeSchema);

// ========== MOCK TEST PAPER SCHEMA ==========
const mockTestPaperSchema = new mongoose.Schema({
  title: String,
  subject: String,
  department: String,
  semester: String,
  year: String,
  marks: Number,
  duration: Number,
  pdfFiles: [{ filename: String, url: String, gridfsId: mongoose.Schema.Types.ObjectId }],
  pdfUrl: String,
  questions: [{
    question: String,
    options: [String],
    correctAnswer: Number,
    modelAnswer: String,
    marks: Number,
    difficulty: String,
    type: { type: String, enum: ['mcq', 'descriptive'], default: 'mcq' }
  }],
  createdAt: { type: Date, default: Date.now }
}, { strict: false, collection: 'mocktestpapers' });
const MockTestPaper = mongoose.model('MockTestPaper', mockTestPaperSchema);

// ========== COMPETITIVE TEST RESULTS SCHEMA ==========
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
}, { strict: false, collection: 'competitivetestresults' });
const CompetitiveTestResult = mongoose.model('CompetitiveTestResult', competitiveTestResultSchema);

// ========== MOCK TEST RESULTS SCHEMA ==========
const mockTestResultSchema = new mongoose.Schema({
  userId: String,
  paperId: String,
  score: Number,
  totalMarks: Number,
  correctCount: Number,
  wrongCount: Number,
  unansweredCount: Number,
  timeTaken: Number,
  completedAt: { type: Date, default: Date.now }
}, { strict: false, collection: 'mocktestresults' });
const MockTestResult = mongoose.model('MockTestResult', mockTestResultSchema);

// ========== REGULAR MOCK TEST SESSION SCHEMA ==========
const testSessionSchema = new mongoose.Schema({
  paperId: { type: mongoose.Schema.Types.ObjectId, ref: 'MockTestPaper', required: true },
  userId: String,
  questions: [{
    question: String,
    options: [String],
    correctAnswer: Number,
    modelAnswer: String,
    marks: Number,
    difficulty: String,
    type: { type: String, enum: ['mcq', 'descriptive'], default: 'mcq' }
  }],
  totalMarks: Number,
  duration: Number,
  createdAt: { type: Date, default: Date.now, expires: 7200 }
});
const TestSession = mongoose.model('TestSession', testSessionSchema);

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
}, { strict: false, collection: 'competitiveexamconfigs' });
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

// ========== EXAM BATCH PLANS ==========

function getExamBatchPlan(examName) {
  const plans = {
    'GATE': {
      totalQuestions: 65,
      totalMarks: 100,
      duration: 180,
      batches: [
        { name: 'General Aptitude A', count: 5, marks: 8, topics: 'Verbal Ability, Numerical Ability, Logical Reasoning', instructions: 'Generate 5 General Aptitude questions. Mix: 3 of 1-mark + 2 of 2-mark. Total: ~8 marks. NON-technical: tricky logical reasoning, pattern-based numerical, subtle verbal questions.' },
        { name: 'General Aptitude B', count: 5, marks: 7, topics: 'Verbal Ability, Numerical Ability, Logical Reasoning', instructions: 'Generate 5 General Aptitude questions. Mix: 2 of 1-mark + 3 of 2-mark. Total: ~7 marks. NON-technical.' },
        { name: 'Technical Part A', count: 8, marks: 12, topics: 'Technical Subject', instructions: 'Generate 8 technical questions. Mix: 5 of 1-mark + 3 of 2-mark. Total: ~12 marks. Cover first portion of syllabus.' },
        { name: 'Technical Part B', count: 8, marks: 12, topics: 'Technical Subject', instructions: 'Generate 8 technical questions. Mix: 5 of 1-mark + 3 of 2-mark. Total: ~12 marks. Cover next portion of syllabus.' },
        { name: 'Technical Part C', count: 8, marks: 12, topics: 'Technical Subject', instructions: 'Generate 8 technical questions. Mix: 5 of 1-mark + 3 of 2-mark. Total: ~12 marks. Cover next portion of syllabus.' },
        { name: 'Technical Part D', count: 8, marks: 12, topics: 'Technical Subject', instructions: 'Generate 8 technical questions. Mix: 5 of 1-mark + 3 of 2-mark. Total: ~12 marks. Cover next portion of syllabus.' },
        { name: 'Technical Part E', count: 8, marks: 12, topics: 'Technical Subject', instructions: 'Generate 8 technical questions. Mix: 5 of 1-mark + 3 of 2-mark. Total: ~12 marks. Cover next portion of syllabus.' },
        { name: 'Technical Part F', count: 8, marks: 12, topics: 'Technical Subject', instructions: 'Generate 8 technical questions. Mix: 5 of 1-mark + 3 of 2-mark. Total: ~12 marks. Cover next portion of syllabus.' },
        { name: 'Technical Part G', count: 7, marks: 11, topics: 'Technical Subject', instructions: 'Generate 7 technical questions. Mix: 4 of 1-mark + 3 of 2-mark. Total: ~11 marks. Cover remaining advanced topics.' }
      ]
    },
    'NEET': {
      totalQuestions: 180,
      totalMarks: 720,
      duration: 180,
      batches: [
        { name: 'Physics Part A', count: 15, marks: 60, topics: 'Physics', instructions: '15 Physics questions. Each 4 marks. Total: 60. Cover mechanics.' },
        { name: 'Physics Part B', count: 15, marks: 60, topics: 'Physics', instructions: '15 Physics questions. Each 4 marks. Total: 60. Cover electromagnetism.' },
        { name: 'Physics Part C', count: 15, marks: 60, topics: 'Physics', instructions: '15 Physics questions. Each 4 marks. Total: 60. Cover modern physics.' },
        { name: 'Chemistry Part A', count: 15, marks: 60, topics: 'Chemistry', instructions: '15 Chemistry questions. Each 4 marks. Total: 60. Physical chemistry.' },
        { name: 'Chemistry Part B', count: 15, marks: 60, topics: 'Chemistry', instructions: '15 Chemistry questions. Each 4 marks. Total: 60. Organic chemistry.' },
        { name: 'Chemistry Part C', count: 15, marks: 60, topics: 'Chemistry', instructions: '15 Chemistry questions. Each 4 marks. Total: 60. Inorganic chemistry.' },
        { name: 'Biology Part A', count: 20, marks: 80, topics: 'Biology', instructions: '20 Biology questions (Botany + Zoology). Each 4 marks. Total: 80.' },
        { name: 'Biology Part B', count: 20, marks: 80, topics: 'Biology', instructions: '20 Biology questions. Each 4 marks. Total: 80.' },
        { name: 'Biology Part C', count: 20, marks: 80, topics: 'Biology', instructions: '20 Biology questions. Each 4 marks. Total: 80.' },
        { name: 'Biology Part D', count: 20, marks: 80, topics: 'Biology', instructions: '20 Biology questions. Each 4 marks. Total: 80.' }
      ]
    },
    'JEE': {
      totalQuestions: 90,
      totalMarks: 360,
      duration: 180,
      batches: [
        { name: 'Physics Part A', count: 15, marks: 60, topics: 'Physics', instructions: '15 Physics questions. Each 4 marks. Total: 60. Mechanics.' },
        { name: 'Physics Part B', count: 15, marks: 60, topics: 'Physics', instructions: '15 Physics questions. Each 4 marks. Total: 60. Electromagnetism + modern physics.' },
        { name: 'Chemistry Part A', count: 15, marks: 60, topics: 'Chemistry', instructions: '15 Chemistry questions. Each 4 marks. Total: 60. Physical chemistry.' },
        { name: 'Chemistry Part B', count: 15, marks: 60, topics: 'Chemistry', instructions: '15 Chemistry questions. Each 4 marks. Total: 60. Organic + inorganic.' },
        { name: 'Mathematics Part A', count: 15, marks: 60, topics: 'Mathematics', instructions: '15 Math questions. Each 4 marks. Total: 60. Algebra + calculus.' },
        { name: 'Mathematics Part B', count: 15, marks: 60, topics: 'Mathematics', instructions: '15 Math questions. Each 4 marks. Total: 60. Geometry + trigonometry + advanced.' }
      ]
    },
    'WBJEE': {
      totalQuestions: 155,
      totalMarks: 200,
      duration: 120,
      batches: [
        { name: 'Math Part A', count: 15, marks: 20, topics: 'Mathematics', instructions: '15 Math questions. Mix of 1-mark and 2-mark. Total: ~20.' },
        { name: 'Math Part B', count: 15, marks: 20, topics: 'Mathematics', instructions: '15 Math questions. Mix of 1-mark and 2-mark. Total: ~20.' },
        { name: 'Math Part C', count: 15, marks: 20, topics: 'Mathematics', instructions: '15 Math questions. Mix of 1-mark and 2-mark. Total: ~20.' },
        { name: 'Math Part D', count: 15, marks: 20, topics: 'Mathematics', instructions: '15 Math questions. Mix of 1-mark and 2-mark. Total: ~20.' },
        { name: 'Physics Part A', count: 15, marks: 20, topics: 'Physics', instructions: '15 Physics questions. Mix of 1-mark and 2-mark. Total: ~20.' },
        { name: 'Physics Part B', count: 15, marks: 20, topics: 'Physics', instructions: '15 Physics questions. Mix of 1-mark and 2-mark. Total: ~20.' },
        { name: 'Chemistry Part A', count: 15, marks: 20, topics: 'Chemistry', instructions: '15 Chemistry questions. Mix of 1-mark and 2-mark. Total: ~20.' },
        { name: 'Chemistry Part B', count: 15, marks: 20, topics: 'Chemistry', instructions: '15 Chemistry questions. Mix of 1-mark and 2-mark. Total: ~20.' }
      ]
    }
  };
  return plans[examName] || null;
}

function buildBatchPrompt(examName, batch, batchIndex, totalBatches, pyqText, syllabusText) {
  const diffInstructions = {
    'GATE': `CRITICAL DIFFICULTY: GATE-level — India's toughest engineering exam. NOT simple textbook problems. Deep conceptual understanding, multi-step problem solving, application of formulas in non-obvious ways. 60% HARD, 30% MEDIUM, 10% EASY. Each question must have one plausible distractor (wrong option) testing common misconceptions.`,
    'NEET': `CRITICAL DIFFICULTY: NEET-level. Biology tests NCERT application beyond rote memorization. Physics is numerical and conceptual. Chemistry tests mechanisms. 40% HARD, 40% MEDIUM, 20% EASY. Each question 4 marks.`,
    'JEE': `CRITICAL DIFFICULTY: JEE Main/Advanced. Multi-step Physics and Chemistry. Mathematics requires clever substitutions. 50% HARD, 35% MEDIUM, 15% EASY. Each question 4 marks.`,
    'WBJEE': `CRITICAL DIFFICULTY: WBJEE competitive state-level. Mathematics has subtle traps. 35% HARD, 45% MEDIUM, 20% EASY.`
  };

  const diffText = diffInstructions[examName] || 'Generate at actual exam difficulty. 40% HARD, 40% MEDIUM, 20% EASY.';

  return `You are an expert Question Setter for the ${examName} examination. Generating BATCH ${batchIndex + 1} of ${totalBatches}.

${diffText}

BATCH DETAILS:
- Section: ${batch.name}
- Questions to generate: EXACTLY ${batch.count}
- Marks: ${batch.marks}
- Topics: ${batch.topics}
- ${batch.instructions}

RULES:
- MCQ only. Each question has exactly 4 options.
- Correct answer: 0-based index (0=first option, 1=second option, 2=third option, 3=fourth option).
- At least one PLAUSIBLE DISTRACTOR (wrong option testing common mistakes).
- Include detailed modelAnswer with step-by-step reasoning for every question.
- Include difficulty (easy, medium, hard) and specific topic tag for each question.
- Return ONLY a valid JSON array. NO markdown, NO code blocks, NO extra text.
- CRITICAL: generate EXACTLY ${batch.count} questions. Not fewer.
- CRITICAL: Do NOT include A, B, C, D labels, prefixes, or markers in the option text. Each option must be plain text only. Never return placeholder text like "A", "B", "C", "D" as option values.
- CRITICAL: ALL questions MUST be based on topics from the syllabus below. Do NOT generate questions on topics outside the syllabus.
- Study the PYQ pattern to match the style and difficulty of real exam questions.

PYQ CONTENT (study pattern, question style, and difficulty):
${pyqText || 'No PYQ content provided.'}

SYLLABUS CONTENT (strictly follow these topics — generate questions ONLY from topics covered in the syllabus):
${syllabusText || 'No syllabus provided.'}

JSON FORMAT (return ONLY this array):
[
  {
    "question": "Question text",
    "options": ["First option text", "Second option text", "Third option text", "Fourth option text"],
    "correctAnswer": 0,
    "modelAnswer": "Detailed explanation",
    "marks": 1,
    "difficulty": "hard",
    "topic": "specific topic",
    "type": "mcq"
  }
]`;
}

function cleanOptionText(opt) {
  const text = String(opt).trim();
  // Strip common option prefixes like "A)", "A.", "A:", "A -", "(A)", "A]", "A}", etc.
  // Case-insensitive match for A-D followed by common separators.
  const prefixPattern = /^(?:\(?[A-Da-d][)\].:\-]\s*|\[[A-Da-d]\]\s*|\{[A-Da-d]\}\s*)/;
  let cleaned = text.replace(prefixPattern, '').trim();
  // If the entire option is just a single letter A-D, treat as empty/invalid placeholder
  if (/^[A-Da-d]$/.test(cleaned)) cleaned = '';
  return cleaned;
}

function fixInvalidEscapes(str) {
  let result = '';
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\' && i + 1 < str.length) {
      const next = str[i + 1];
      if (['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(next)) {
        result += '\\' + next;
        i++;
      } else if (next === 'u') {
        const hex = str.substring(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          result += '\\u' + hex;
          i += 5;
        } else {
          result += '\\\\';
        }
      } else {
        // Invalid escape (e.g., LaTeX \sum, \frac) — double the backslash
        result += '\\\\' + next;
        i++;
      }
    } else if (str[i] === '\\' && i + 1 >= str.length) {
      // Trailing backslash
      result += '\\\\';
    } else {
      result += str[i];
    }
  }
  return result;
}

function extractValidObjects(str) {
  const objects = [];
  let inString = false;
  let escapeNext = false;
  let braceDepth = 0;
  let objStart = -1;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') {
        if (braceDepth === 0) objStart = i;
        braceDepth++;
      } else if (char === '}') {
        braceDepth--;
        if (braceDepth === 0 && objStart >= 0) {
          const objStr = str.substring(objStart, i + 1);
          try {
            objects.push(JSON.parse(objStr));
          } catch (e) {
            try {
              objects.push(JSON.parse(fixInvalidEscapes(objStr)));
            } catch (e2) {
              // Object unrecoverable, skip
            }
          }
          objStart = -1;
        }
      }
    }
  }

  return objects;
}

function parseAIResponse(aiResponse, batch) {
  if (!aiResponse) return { questions: [], error: 'No AI response' };

  let cleanedResponse = aiResponse.trim();

  // Remove markdown code blocks if present
  if (cleanedResponse.startsWith('```json')) {
    cleanedResponse = cleanedResponse.substring(7);
    if (cleanedResponse.endsWith('```')) cleanedResponse = cleanedResponse.slice(0, -3);
  } else if (cleanedResponse.startsWith('```')) {
    cleanedResponse = cleanedResponse.substring(3);
    if (cleanedResponse.endsWith('```')) cleanedResponse = cleanedResponse.slice(0, -3);
  }
  cleanedResponse = cleanedResponse.trim();

  // Extract just the JSON array — find first '[' and last ']'
  const firstBracket = cleanedResponse.indexOf('[');
  const lastBracket = cleanedResponse.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    cleanedResponse = cleanedResponse.substring(firstBracket, lastBracket + 1);
  }

  // Fix common AI output issues that break JSON:
  // 1. Unescaped newlines inside string values → replace with space
  cleanedResponse = cleanedResponse.replace(/\n\s*/g, ' ');
  // 2. Remove null characters
  cleanedResponse = cleanedResponse.replace(/\u0000/g, '');
  // 3. Fix trailing commas before closing brackets
  cleanedResponse = cleanedResponse.replace(/,\s*([}\]])/g, '$1');
  // 4. Fix missing commas between objects
  cleanedResponse = cleanedResponse.replace(/}\s*{/g, '},{');

  let rawQuestions;
  try {
    rawQuestions = JSON.parse(cleanedResponse);
  } catch (parseErr) {
    console.error(`[Competitive Mock] JSON parse error: ${parseErr.message}`);
    console.error(`[Competitive Mock] Cleaned first 300 chars: ${cleanedResponse.substring(0, 300)}`);
    console.error(`[Competitive Mock] Cleaned last 300 chars: ${cleanedResponse.substring(cleanedResponse.length - 300)}`);

    // Try fixing invalid escape sequences (e.g., LaTeX \sum, \frac)
    const fixedEscapes = fixInvalidEscapes(cleanedResponse);
    try {
      rawQuestions = JSON.parse(fixedEscapes);
      console.log(`[Competitive Mock] Parsed successfully after fixing invalid escapes.`);
    } catch (fixErr) {
      console.error(`[Competitive Mock] Still failing after escape fix: ${fixErr.message}`);

      // Fallback: extract individual objects from the malformed array
      const extractedObjects = extractValidObjects(cleanedResponse);
      if (extractedObjects.length > 0) {
        console.log(`[Competitive Mock] Extracted ${extractedObjects.length} valid objects from malformed JSON.`);
        rawQuestions = extractedObjects;
      } else {
        return { questions: [], error: 'JSON parse error: ' + parseErr.message };
      }
    }
  }

  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return { questions: [], error: 'Empty or invalid array' };
  }

  const questions = [];
  for (const q of rawQuestions) {
    if (!q.question) continue;
    if (!Array.isArray(q.options) || q.options.length !== 4) continue;
    if (typeof q.correctAnswer !== 'number' || q.correctAnswer < 0 || q.correctAnswer > 3) continue;
    const cleanedOptions = q.options.map(cleanOptionText);
    // Reject if any option is empty after stripping labels (prevents placeholder "A","B","C","D")
    if (cleanedOptions.some(o => o.length === 0)) continue;
    questions.push({
      question: q.question.trim(),
      options: cleanedOptions,
      correctAnswer: Math.round(q.correctAnswer),
      modelAnswer: q.modelAnswer || '',
      marks: Number(q.marks) || 1,
      difficulty: ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : 'medium',
      topic: q.topic || (batch && batch.topics) || '',
      type: 'mcq'
    });
  }

  return { questions, error: null };
}

function getTargetDifficulty(percentage) {
  if (percentage < 40) return 'easy';
  if (percentage < 60) return 'medium';
  if (percentage < 75) return 'medium-hard';
  return 'hard';
}

// Run one batch using a specific key
async function runBatchWithKey(config, batch, batchIndex, totalBatches, pyqText, syllabusText, keyIndex) {
  const prompt = buildBatchPrompt(config.examName, batch, batchIndex, totalBatches, pyqText, syllabusText);
  const apiKey = AI_API_MOCK_KEYS[keyIndex];
  console.log(`[Competitive Mock] Batch ${batchIndex + 1}: ${batch.name} (${batch.count} questions) — using key ${keyIndex + 1}/${AI_API_MOCK_KEYS.length}`);

  const result = await callGroqMock(prompt, apiKey, 4000);

  if (!result.success && result.retryAfter) {
    markKeyUsed(keyIndex, (result.retryAfter * 1000) + 3000); // cooldown the rate-limited key using actual retryAfter + 3s buffer
    console.log(`[Competitive Mock] Batch ${batchIndex + 1} rate limited, key ${keyIndex + 1} cooled down for ${result.retryAfter}s`);
    return { success: false, error: 'Rate limited', retryAfter: result.retryAfter };
  }

  if (!result.success || !result.content) {
    console.error(`[Competitive Mock] Batch ${batchIndex + 1} API call failed — no content returned`);
    return { success: false, error: 'API error (no content)' };
  }

  const parsed = parseAIResponse(result.content, batch);
  if (parsed.questions.length > 0) {
    console.log(`[Competitive Mock] Batch ${batchIndex + 1}: ${parsed.questions.length} valid questions`);
    return { success: true, questions: parsed.questions };
  }

  console.error(`[Competitive Mock] Batch ${batchIndex + 1} parse failed: ${parsed.error || 'Unknown'}`);
  return { success: false, error: parsed.error || 'Parse error' };
}

// ========== MAIN COMPETITIVE GENERATION (PARALLEL WITH 2 KEYS) ==========
async function generateCompetitiveQuestionsFromExam(config, totalMarks, duration) {
  try {
    if (!aiMockEnabled) {
      return { success: false, error: 'No AI keys configured. Set AI_API_MOCK1 and AI_API_MOCK2 environment variables.' };
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

    const MAX_CHARS = 1500;
    let combinedPyqText = pyqText;
    if (combinedPyqText.length > MAX_CHARS) combinedPyqText = combinedPyqText.substring(0, MAX_CHARS) + '\n\n[Truncated...]';
    let combinedSyllabusText = syllabusText;
    if (combinedSyllabusText.length > MAX_CHARS) combinedSyllabusText = combinedSyllabusText.substring(0, MAX_CHARS) + '\n\n[Truncated...]';

    console.log(`[Competitive Mock] Content loaded — PYQ: ${combinedPyqText.length} chars, Syllabus: ${combinedSyllabusText.length} chars`);

    console.log(`[Competitive Mock] Starting PARALLEL generation for ${config.examName} with ${AI_API_MOCK_KEYS.length} key(s). ${plan.batches.length} batches. Model: llama-3.1-8b-instant.`);
    const startTime = Date.now();

    const allQuestions = [];
    const failedBatches = []; // stores { batchIndex, batch } for retry
    const underfilledBatches = []; // stores { batchIndex, batch, originalCount } for retry

    // Process batches in rounds: up to 2 batches per round (one per key), with cooldown between rounds
    let batchIndex = 0;
    while (batchIndex < plan.batches.length) {
      const availableKey1 = getAvailableKey();
      if (availableKey1 < 0) {
        console.log(`[Competitive Mock] All keys on cooldown. Waiting...`);
        await waitForAnyKey();
        continue;
      }

      const batch1 = plan.batches[batchIndex];
      const promise1 = runBatchWithKey(config, batch1, batchIndex, plan.batches.length, combinedPyqText, combinedSyllabusText, availableKey1);
      markKeyUsed(availableKey1);
      let promise2 = null;
      let batch2 = null;

      // Try to pair with a second batch if another key is available
      // Stagger the second request by 3s to avoid TPM burst on both keys simultaneously
      batchIndex++;
      if (batchIndex < plan.batches.length) {
        const availableKey2 = getAvailableKey();
        if (availableKey2 >= 0 && availableKey2 !== availableKey1) {
          batch2 = plan.batches[batchIndex];
          await delay(3000); // stagger second request to spread TPM load
          promise2 = runBatchWithKey(config, batch2, batchIndex, plan.batches.length, combinedPyqText, combinedSyllabusText, availableKey2);
          markKeyUsed(availableKey2);
          batchIndex++;
        }
      }

      console.log(`[Competitive Mock] Round: ${batch1.name}${batch2 ? ' + ' + batch2.name : ''} with ${promise2 ? 2 : 1} key(s)`);
      const results = promise2
        ? await Promise.all([promise1, promise2])
        : [await promise1];

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const currentBatch = i === 0 ? batch1 : batch2;
        const currentBatchIndex = batchIndex - results.length + i;
        if (result.success && result.questions.length > 0) {
          allQuestions.push(...result.questions);
          // Track underfilled batches for retry
          if (result.questions.length < currentBatch.count) {
            const missing = currentBatch.count - result.questions.length;
            underfilledBatches.push({
              batchIndex: currentBatchIndex,
              batch: { ...currentBatch, count: missing },
              originalCount: currentBatch.count,
              generatedCount: result.questions.length
            });
            console.log(`[Competitive Mock] Batch ${currentBatchIndex + 1} underfilled: ${result.questions.length}/${currentBatch.count}. Will retry for ${missing} more.`);
          }
        } else {
          failedBatches.push({ batchIndex: currentBatchIndex, batch: currentBatch, error: result.error || 'Unknown', retryAfter: result.retryAfter || 0 });
          console.error(`[Competitive Mock] Batch ${currentBatchIndex + 1} FAILED: ${result.error || 'Unknown error'}`);
        }
      }

      console.log(`[Competitive Mock] Round complete. Total: ${allQuestions.length} questions.`);

      // Pause before next round to let TPM windows reset
      if (batchIndex < plan.batches.length) {
        console.log(`[Competitive Mock] Pausing ${PAUSE_BETWEEN_ROUNDS_MS / 1000}s before next round...`);
        await delay(PAUSE_BETWEEN_ROUNDS_MS);
      }
    }

    // Retry failed batches once at the end with any available key
    if (failedBatches.length > 0) {
      console.log(`[Competitive Mock] Retrying ${failedBatches.length} failed batch(es)...`);
      for (let attempt = 0; attempt < failedBatches.length; attempt++) {
        const retry = failedBatches[attempt];
        // If previous failure was rate limit, wait for the specific retryAfter + buffer
        if (retry.error === 'Rate limited' && retry.retryAfter > 0) {
          const waitTime = (retry.retryAfter * 1000) + 3000;
          console.log(`[Competitive Mock] Waiting ${Math.round(waitTime / 1000)}s for rate limit cooldown before retrying batch ${retry.batchIndex + 1}...`);
          await delay(waitTime);
        }
        let availableKey = getAvailableKey();
        if (availableKey < 0) {
          await waitForAnyKey();
          availableKey = getAvailableKey();
          if (availableKey < 0) availableKey = 0;
        }
        const retryResult = await runBatchWithKey(config, retry.batch, retry.batchIndex, plan.batches.length, combinedPyqText, combinedSyllabusText, availableKey);
        if (retryResult.success && retryResult.questions.length > 0) {
          allQuestions.push(...retryResult.questions);
          console.log(`[Competitive Mock] Retry batch ${retry.batchIndex + 1}: ${retryResult.questions.length} valid questions`);
          // Check if still underfilled after retry
          if (retryResult.questions.length < retry.batch.count) {
            const missing = retry.batch.count - retryResult.questions.length;
            underfilledBatches.push({
              batchIndex: retry.batchIndex,
              batch: { ...retry.batch, count: missing },
              originalCount: retry.batch.count,
              generatedCount: retryResult.questions.length
            });
            console.log(`[Competitive Mock] Retry batch ${retry.batchIndex + 1} still underfilled: ${retryResult.questions.length}/${retry.batch.count}. Will retry for ${missing} more.`);
          }
        } else {
          console.error(`[Competitive Mock] Retry batch ${retry.batchIndex + 1} failed: ${retryResult.error || 'Unknown'}`);
        }
        if (attempt < failedBatches.length - 1) {
          await delay(RETRY_COOLDOWN_MS);
        }
      }
    }

    // Retry underfilled batches after cooldown to generate missing questions on the exact same topic
    if (underfilledBatches.length > 0) {
      console.log(`[Competitive Mock] Retrying ${underfilledBatches.length} underfilled batch(es) for missing questions...`);
      for (let attempt = 0; attempt < underfilledBatches.length; attempt++) {
        const retry = underfilledBatches[attempt];
        let availableKey = getAvailableKey();
        if (availableKey < 0) {
          await waitForAnyKey();
          availableKey = getAvailableKey();
          if (availableKey < 0) availableKey = 0;
        }
        const retryResult = await runBatchWithKey(config, retry.batch, retry.batchIndex, plan.batches.length, combinedPyqText, combinedSyllabusText, availableKey);
        if (retryResult.success && retryResult.questions.length > 0) {
          allQuestions.push(...retryResult.questions);
          console.log(`[Competitive Mock] Underfill retry batch ${retry.batchIndex + 1}: ${retryResult.questions.length} valid questions (target was ${retry.batch.count})`);
        } else {
          console.error(`[Competitive Mock] Underfill retry batch ${retry.batchIndex + 1} failed: ${retryResult.error || 'Unknown'}`);
        }
        if (attempt < underfilledBatches.length - 1) {
          await delay(RETRY_COOLDOWN_MS);
        }
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Competitive Mock] Parallel generation completed in ${elapsed}s`);

    if (allQuestions.length === 0) {
      return { success: false, error: 'All batches failed. No questions generated. Check AI keys and try again.' };
    }

    console.log(`[Competitive Mock] Generated ${allQuestions.length} of ${plan.totalQuestions} target questions.`);
    return { success: true, questions: allQuestions };
  } catch (err) {
    console.error('generateCompetitiveQuestionsFromExam error:', err);
    return { success: false, error: err.message };
  }
}

// ========== AUTH & MIDDLEWARE ==========

const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

const adminMiddleware = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
};

// ========== GRIDFS SETUP ==========
const conn = mongoose.connection;
let gfs, gridfsBucket;
conn.once('open', () => {
  gridfsBucket = new mongoose.mongo.GridFSBucket(conn.db, { bucketName: 'uploads' });
  gfs = gridfsBucket;
  console.log('GridFS Bucket initialized');
});

async function uploadBufferToGridFS(buffer, filename) {
  return new Promise((resolve, reject) => {
    const uploadStream = gfs.openUploadStream(filename, { contentType: 'application/pdf' });
    uploadStream.end(buffer, (err) => {
      if (err) reject(err);
      else resolve(uploadStream.id);
    });
  });
}

async function deleteFromGridFS(gridfsId) {
  try {
    await gfs.delete(gridfsId);
  } catch (err) {
    console.error('GridFS delete error:', err.message);
  }
}

const upload = multer({ storage: multer.memoryStorage() });

// ========== AUTH ROUTES ==========

// POST /register
app.post('/register', async (req, res) => {
  try {
    const { name, cin, roll, year, department } = req.body;
    if (!name || !cin || !roll || !year || !department) {
      return res.status(400).send('All fields are required');
    }
    const existing = await Student.findOne({ cin });
    if (existing) return res.status(400).send('CIN already registered');
    const student = new Student({ name, cin, roll, year, department });
    await student.save();
    const token = jwt.sign({ id: student._id, cin: student.cin, role: student.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: student._id, name: student.name, cin: student.cin, role: student.role } });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// POST /login
app.post('/login', async (req, res) => {
  try {
    const { name, cin } = req.body;
    if (!name || !cin) return res.status(400).send('Name and CIN required');
    const student = await Student.findOne({ name, cin });
    if (!student) return res.status(401).send('Invalid credentials');
    const token = jwt.sign({ id: student._id, cin: student.cin, role: student.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: student._id, name: student.name, cin: student.cin, role: student.role } });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// POST /admin-login
app.post('/admin-login', async (req, res) => {
  try {
    const { name, cin, password } = req.body;
    if (!name || !cin || !password) return res.status(400).send('All fields required');
    const student = await Student.findOne({ name: name.trim(), cin: cin.trim() });
    if (!student) return res.status(401).send('Student not found. Please register first.');
    const adminPassword = (process.env.ADMIN_PASSWORD || '').trim();
    if (password.trim() !== adminPassword) {
      console.log(`[Admin Login] Wrong password for ${name}. Expected: "${adminPassword}" (length ${adminPassword.length}), Got: "${password.trim()}" (length ${password.trim().length})`);
      return res.status(401).send('Invalid admin password');
    }
    student.role = 'admin';
    await student.save();
    const token = jwt.sign({ id: student._id, cin: student.cin, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: student._id, name: student.name, cin: student.cin, role: 'admin' } });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// ========== ROUTES ==========

// Seed materials from JSON on startup
async function seedMaterials() {
  try {
    const count = await Material.countDocuments();
    if (count === 0) {
      const seedData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'seed-materials.json'), 'utf-8'));
      await Material.insertMany(seedData);
      console.log(`Seeded ${seedData.length} materials`);
    }
  } catch (err) {
    console.error('Seed error:', err.message);
  }
}
seedMaterials();

// GET /api/materials
app.get('/api/materials', async (req, res) => {
  try {
    const materials = await Material.find().sort({ createdAt: -1 });
    // Normalize semester values to match frontend filter expectations
    const normalized = materials.map(m => ({
      ...m.toObject(),
      semester: m.semester?.replace(/^Sem\s+([IV]+)$/, (match, rom) => {
        const map = { I: 'Semester I', II: 'Semester II', III: 'Semester III', IV: 'Semester IV', V: 'Semester V', VI: 'Semester VI' };
        return map[rom] || match;
      }) || m.semester
    }));
    res.json(normalized);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/notices/active
app.get('/api/notices/active', async (req, res) => {
  try {
    const notice = await Notice.findOne({ active: true }).sort({ createdAt: -1 });
    if (!notice) return res.status(404).json({ error: 'No active notice' });
    res.json({ message: notice.message });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/user/profile
app.get('/api/user/profile', authMiddleware, async (req, res) => {
  try {
    const student = await Student.findById(req.user.id);
    if (!student) return res.status(404).json({ error: 'User not found' });
    res.json({
      id: student._id,
      name: student.name,
      roll: student.roll,
      department: student.department,
      year: student.year,
      cin: student.cin,
      downloadsCount: student.downloadsCount,
      contributionsCount: student.contributionsCount,
      role: student.role
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/download-track
app.post('/api/download-track', authMiddleware, async (req, res) => {
  try {
    const student = await Student.findById(req.user.id);
    if (student) {
      student.downloadsCount = (student.downloadsCount || 0) + 1;
      await student.save();
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/mock-tests/papers
app.get('/api/mock-tests/papers', authMiddleware, async (req, res) => {
  try {
    const papers = await MockTestPaper.find().sort({ createdAt: -1 });
    res.json(papers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/mock-tests/papers/:id
app.get('/api/mock-tests/papers/:id', authMiddleware, async (req, res) => {
  try {
    const paper = await MockTestPaper.findById(req.params.id);
    if (!paper) return res.status(404).json({ error: 'Paper not found' });
    res.json(paper);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/mock-tests/results (supports ?paperId= query param)
app.get('/api/mock-tests/results', authMiddleware, async (req, res) => {
  try {
    const query = { userId: req.user.id };
    if (req.query.paperId) query.paperId = req.query.paperId;
    const results = await MockTestResult.find(query).sort({ completedAt: -1 });
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/mock-tests/results/:paperId
app.get('/api/mock-tests/results/:paperId', authMiddleware, async (req, res) => {
  try {
    const results = await MockTestResult.find({ userId: req.user.id, paperId: req.params.paperId }).sort({ completedAt: -1 });
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/mock-tests/:paperId/previous-result — fetch last result for adaptive difficulty
app.get('/api/mock-tests/:paperId/previous-result', authMiddleware, async (req, res) => {
  try {
    const result = await MockTestResult.findOne({ userId: req.user.id, paperId: req.params.paperId }).sort({ completedAt: -1 });
    if (!result) {
      return res.json({ hasPreviousResult: false });
    }
    const percentage = result.totalMarks > 0 ? Math.round((result.score / result.totalMarks) * 100) : 0;
    res.json({
      hasPreviousResult: true,
      score: result.score,
      totalMarks: result.totalMarks,
      percentage: percentage,
      targetDifficulty: getTargetDifficulty(percentage)
    });
  } catch (err) {
    console.error('Previous result fetch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/mock-tests/:paperId/start — generate AI questions for a regular mock test
app.post('/api/mock-tests/:paperId/start', authMiddleware, async (req, res) => {
  try {
    const { paperId } = req.params;
    const { marks, duration, questionType, targetDifficulty } = req.body;
    const totalMarks = Number(marks) || 30;
    const testDuration = Number(duration) || 60;
    const qType = questionType || 'mcq';

    const paper = await MockTestPaper.findById(paperId);
    if (!paper) return res.status(404).json({ error: 'Paper not found' });

    // Extract text from PYQ PDFs
    let pdfText = '';
    if (paper.pdfFiles && paper.pdfFiles.length > 0) {
      const texts = await extractTextFromFileObjects(paper.pdfFiles);
      pdfText = texts.join('\n\n---\n\n');
    } else if (paper.pdfUrl) {
      try {
        const pdfRes = await fetch(paper.pdfUrl);
        if (pdfRes.ok) {
          const buffer = Buffer.from(await pdfRes.arrayBuffer());
          const pdfData = await pdfParse(buffer);
          pdfText = pdfData.text || '';
        }
      } catch (e) {
        console.error('PDF fetch error:', e.message);
      }
    }

    // Extract text from syllabus PDFs
    let syllabusText = '';
    if (paper.syllabusFiles && paper.syllabusFiles.length > 0) {
      const texts = await extractTextFromFileObjects(paper.syllabusFiles);
      syllabusText = texts.join('\n\n---\n\n');
    }

    if (!pdfText && !syllabusText) {
      return res.status(400).json({ error: 'No PDF or syllabus content available for this paper.' });
    }

    const MAX_CHARS = 2000;
    let truncatedPyqText = pdfText;
    if (truncatedPyqText.length > MAX_CHARS) truncatedPyqText = truncatedPyqText.substring(0, MAX_CHARS) + '\n\n[Truncated...]';
    let truncatedSyllabusText = syllabusText;
    if (truncatedSyllabusText.length > MAX_CHARS) truncatedSyllabusText = truncatedSyllabusText.substring(0, MAX_CHARS) + '\n\n[Truncated...]';

    // Build prompt
    const diff = targetDifficulty || 'medium';
    let qTypeInstruction = '';
    if (qType === 'mcq') {
      qTypeInstruction = 'Generate ONLY MCQ questions. Each question has exactly 4 options and one correct answer (0-based index).';
    } else if (qType === 'descriptive') {
      qTypeInstruction = 'Generate ONLY descriptive questions. No options needed. Provide a model answer for each question.';
    } else {
      qTypeInstruction = 'Generate a MIX of questions. For MCQ questions, provide exactly 4 options and a correct answer (0-based index). For descriptive questions, provide a model answer and no options.';
    }

    const prompt = `You are an experienced exam question setter. Based on the following PYQ questions and syllabus, generate a mock test with questions worth a total of ${totalMarks} marks. The test duration is ${testDuration} minutes.

${qTypeInstruction}

DIFFICULTY: ${diff}

${truncatedPyqText ? `PYQ CONTENT (study pattern, question style, and difficulty):\n${truncatedPyqText}\n\n` : ''}${truncatedSyllabusText ? `SYLLABUS CONTENT (strictly follow these topics — generate questions ONLY from topics covered in the syllabus):\n${truncatedSyllabusText}\n\n` : ''}RULES:
- ALL questions MUST be based on topics from the syllabus. Do NOT generate questions on topics outside the syllabus.
- Study the PYQ pattern to match the style and difficulty of real exam questions.
- Return a VALID JSON ARRAY of questions. Each question is an object.
- MCQ format: { "question": "...", "options": ["A", "B", "C", "D"], "correctAnswer": 0, "marks": 1, "difficulty": "easy|medium|hard", "type": "mcq" }
- Descriptive format: { "question": "...", "modelAnswer": "...", "marks": 1, "difficulty": "easy|medium|hard", "type": "descriptive" }
- Options must not be empty. No placeholder letters like "A", "B", "C", "D" as options.
- Correct answer for MCQ is 0-based index (0=first option, 1=second, etc.).
- Generate questions whose total marks add up to approximately ${totalMarks}.
- Return ONLY the JSON array. No markdown, no code blocks, no extra text.`;

    // Call Groq API (use regular AI key, fallback to mock key)
    const apiKey = AI_API_KEY || (AI_API_MOCK_KEYS.length > 0 ? AI_API_MOCK_KEYS[0] : '');
    if (!apiKey) return res.status(400).json({ error: 'AI is not configured. Please contact admin.' });

    const result = await callGroqMock(prompt, apiKey, 4000);
    if (!result.success || !result.content) {
      return res.status(500).json({ error: 'AI question generation failed. Please try again.' });
    }

    const parsed = parseAIResponse(result.content, { count: 999, marks: 1 });
    if (!parsed.questions || parsed.questions.length === 0) {
      return res.status(500).json({ error: 'No valid questions were generated. Please try again.' });
    }

    let actualTotalMarks = 0;
    for (const q of parsed.questions) {
      actualTotalMarks += q.marks || 1;
    }

    const session = new TestSession({
      paperId,
      userId: req.user.id,
      questions: parsed.questions,
      totalMarks: actualTotalMarks,
      duration: testDuration
    });
    await session.save();

    const clientQuestions = parsed.questions.map((q, idx) => ({
      id: idx,
      question: q.question,
      options: q.options || [],
      marks: q.marks || 1,
      difficulty: q.difficulty || 'medium',
      type: q.type || 'mcq',
      modelAnswer: q.modelAnswer || ''
    }));

    res.json({
      testId: session._id,
      paper: {
        title: paper.title,
        subject: paper.subject || '',
        department: paper.department || '',
        semester: paper.semester || ''
      },
      questions: clientQuestions,
      totalMarks: actualTotalMarks,
      duration: testDuration
    });
  } catch (err) {
    console.error('Start mock test error:', err);
    res.status(500).json({ error: 'Server error during test generation' });
  }
});

// POST /api/mock-tests/:paperId/submit — submit answers for a regular mock test
app.post('/api/mock-tests/:paperId/submit', authMiddleware, async (req, res) => {
  try {
    const { paperId } = req.params;
    const { testId, answers, timeTaken } = req.body;
    if (!testId) return res.status(400).json({ error: 'Test ID required' });

    const session = await TestSession.findById(testId);
    if (!session) return res.status(400).json({ error: 'Test session expired. Please start a new test.' });

    const questions = session.questions;
    const userAnswers = answers || [];

    let score = 0, correct = 0, wrong = 0, unanswered = 0;
    const answerMap = {};
    userAnswers.forEach(a => { answerMap[a.questionId] = a; });

    const detailedResults = questions.map((q, idx) => {
      const userAnswer = answerMap[idx];
      const selected = userAnswer ? userAnswer.selectedOption : undefined;
      const isCorrect = selected === q.correctAnswer;
      const isUnanswered = selected === undefined || selected === null;

      if (q.type === 'descriptive') {
        return {
          questionId: idx,
          question: q.question,
          type: 'descriptive',
          marks: q.marks || 1,
          textAnswer: userAnswer ? (userAnswer.textAnswer || '') : '',
          fileId: userAnswer ? (userAnswer.fileId || '') : '',
          fileName: userAnswer ? (userAnswer.fileName || '') : '',
          modelAnswer: q.modelAnswer || '',
          isCorrect: null
        };
      }

      if (isCorrect) { score += q.marks; correct++; }
      else if (isUnanswered) { unanswered++; }
      else { wrong++; }

      return {
        questionId: idx,
        question: q.question,
        options: q.options || [],
        correctAnswer: q.correctAnswer,
        selectedOption: selected,
        isCorrect,
        marks: q.marks || 1,
        type: 'mcq'
      };
    });

    const result = new MockTestResult({
      userId: req.user.id,
      paperId,
      score,
      totalMarks: session.totalMarks,
      correctCount: correct,
      wrongCount: wrong,
      unansweredCount: unanswered,
      timeTaken: Number(timeTaken) || 0
    });
    await result.save();

    await TestSession.findByIdAndDelete(testId);

    const percentage = session.totalMarks > 0 ? ((score / session.totalMarks) * 100).toFixed(2) : '0.00';

    res.json({
      score,
      totalMarks: session.totalMarks,
      percentage,
      correctCount: correct,
      wrongCount: wrong,
      unansweredCount: unanswered,
      timeTaken: Number(timeTaken) || 0,
      detailedResults
    });
  } catch (err) {
    console.error('Submit mock test error:', err);
    res.status(500).json({ error: 'Server error during submission' });
  }
});

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

// Admin: Upload PYQ PDFs
app.post('/api/admin/competitive-exams/:examName/pyq', authMiddleware, adminMiddleware, upload.array('pyq', 10), async (req, res) => {
  try {
    const { examName } = req.params;
    if (!['NEET', 'JEE', 'GATE', 'WBJEE'].includes(examName)) return res.status(400).json({ error: 'Invalid exam name' });
    const config = await CompetitiveExamConfig.findOne({ examName });
    if (!config) return res.status(404).json({ error: 'Exam config not found. Create it first.' });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No PDF files uploaded' });

    const newFiles = [];
    const buffers = [];
    for (const file of req.files) {
      const gridfsId = await uploadBufferToGridFS(file.buffer, file.originalname);
      newFiles.push({ gridfsId, filename: file.originalname, originalName: file.originalname, uploadedAt: new Date() });
      buffers.push(file.buffer);
    }
    config.pyqFiles = config.pyqFiles || [];
    config.pyqFiles.push(...newFiles);
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

// Admin: Upload Syllabus PDFs
app.post('/api/admin/competitive-exams/:examName/syllabus', authMiddleware, adminMiddleware, upload.array('syllabus', 5), async (req, res) => {
  try {
    const { examName } = req.params;
    if (!['NEET', 'JEE', 'GATE', 'WBJEE'].includes(examName)) return res.status(400).json({ error: 'Invalid exam name' });
    const config = await CompetitiveExamConfig.findOne({ examName });
    if (!config) return res.status(404).json({ error: 'Exam config not found. Create it first.' });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No syllabus PDF files uploaded' });

    const newFiles = [];
    const buffers = [];
    for (const file of req.files) {
      const gridfsId = await uploadBufferToGridFS(file.buffer, file.originalname);
      newFiles.push({ gridfsId, filename: file.originalname, originalName: file.originalname, uploadedAt: new Date() });
      buffers.push(file.buffer);
    }
    config.syllabusFiles = config.syllabusFiles || [];
    config.syllabusFiles.push(...newFiles);
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

// Admin: Delete a competitive exam config
app.delete('/api/admin/competitive-exams/:examName', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { examName } = req.params;
    const config = await CompetitiveExamConfig.findOne({ examName });
    if (!config) return res.status(404).json({ error: 'Exam config not found' });
    if (config.pyqFiles) for (const f of config.pyqFiles) if (f.gridfsId) try { await deleteFromGridFS(f.gridfsId); } catch (e) {}
    if (config.syllabusFiles) for (const f of config.syllabusFiles) if (f.gridfsId) try { await deleteFromGridFS(f.gridfsId); } catch (e) {}
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
    aiMockEnabled,
    groqKeys: AI_API_MOCK_KEYS.length,
    message: aiMockEnabled
      ? `Groq configured with ${AI_API_MOCK_KEYS.length} key(s). Parallel rounds: ${AI_API_MOCK_KEYS.length} batches per round with ${PAUSE_BETWEEN_ROUNDS_MS / 1000}s cooldown.`
      : 'No AI_API_MOCK1 or AI_API_MOCK2 keys configured. Set at least one Groq API key.'
  });
});

// User: List available competitive exams
app.get('/api/competitive-exams', authMiddleware, async (req, res) => {
  try {
    const configs = await CompetitiveExamConfig.find({
      $or: [{ status: 'active' }, { status: { $exists: false } }]
    }).select('-__v').sort({ examName: 1 });
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
    if (!['NEET', 'JEE', 'GATE', 'WBJEE'].includes(examName)) return res.status(400).json({ error: 'Invalid exam name' });
    const config = await CompetitiveExamConfig.findOne({ examName, status: 'active' });
    if (!config) return res.status(404).json({ error: 'Exam not found or not active' });
    const { marks, duration } = req.body;
    const totalMarks = Number(marks) || config.totalMarks || 300;
    const testDuration = Number(duration) || config.duration || 180;

    if (!aiMockEnabled) return res.status(400).json({ error: 'AI Mock is not configured.' });

    const result = await generateCompetitiveQuestionsFromExam(config, totalMarks, testDuration);
    if (!result.success) return res.status(500).json({ error: result.error || 'Question generation failed' });

    const questions = result.questions;
    let actualTotalMarks = 0;
    for (const q of questions) actualTotalMarks += q.marks;

    const session = new CompetitiveTestSession({
      examName,
      userId: req.user.id,
      questions,
      totalMarks: actualTotalMarks,
      duration: testDuration
    });
    await session.save();

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
    if (!session) return res.status(400).json({ error: 'Test session expired. Please start a new test.' });
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
      answers: userAnswers.map(a => ({ questionId: a.questionId, selectedOption: a.selectedOption })),
      score,
      totalMarks: session.totalMarks,
      correctCount: correct,
      wrongCount: wrong,
      unansweredCount: unanswered,
      timeTaken: timeTaken || 0
    });
    await result.save();
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
    const results = await CompetitiveTestResult.find({ userId: req.user.id }).sort({ completedAt: -1 });
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/competitive-exams/:examName/results', authMiddleware, async (req, res) => {
  try {
    const results = await CompetitiveTestResult.find({ userId: req.user.id, examName: req.params.examName }).sort({ completedAt: -1 });
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ========== ADMIN DASHBOARD ROUTES ==========

app.get('/api/admin/metrics', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const totalDownloads = await Student.aggregate([{ $group: { _id: null, total: { $sum: '$downloadsCount' } } }]);
    const totalContributions = await Student.aggregate([{ $group: { _id: null, total: { $sum: '$contributionsCount' } } }]);
    const topContributors = await Student.find().sort({ contributionsCount: -1 }).limit(5).select('name department contributionsCount');
    const topDownloader = await Student.findOne().sort({ downloadsCount: -1 }).select('name department downloadsCount');
    res.json({
      totalDownloads: totalDownloads[0]?.total || 0,
      totalContributions: totalContributions[0]?.total || 0,
      topContributors: topContributors.map(c => ({ name: c.name, department: c.department, contributionsCount: c.contributionsCount })),
      topDownloader: topDownloader ? { name: topDownloader.name, department: topDownloader.department, downloadsCount: topDownloader.downloadsCount } : null,
      demographics: null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/demographics', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const deptBreakdown = await Student.aggregate([{ $group: { _id: '$department', count: { $sum: 1 } } }]);
    const yearBreakdown = await Student.aggregate([{ $group: { _id: '$year', count: { $sum: 1 } } }]);
    res.json({
      departmentBreakdown: deptBreakdown.map(d => ({ department: d._id || 'Unknown', count: d.count })),
      yearBreakdown: yearBreakdown.map(y => ({ year: y._id || 'Unknown', count: y.count })),
      totalStudents: await Student.countDocuments()
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/mock-tests', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const papers = await MockTestPaper.find().sort({ createdAt: -1 });
    res.json(papers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/mock-tests', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { title, subject, department, semester, year } = req.body;
    const paper = new MockTestPaper({ title, subject, department, semester, year });
    await paper.save();
    res.json({ success: true, message: 'Paper created', paper });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/mock-tests/papers', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { title, subject, department, semester, year } = req.body;
    const paper = new MockTestPaper({ title, subject, department, semester, year });
    await paper.save();
    res.json({ success: true, message: 'Paper created', paper });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/mock-tests/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await MockTestPaper.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/mock-tests/:paperId/pdfs', authMiddleware, adminMiddleware, upload.array('pdfs', 10), async (req, res) => {
  try {
    const paper = await MockTestPaper.findById(req.params.paperId);
    if (!paper) return res.status(404).json({ error: 'Paper not found' });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No PDFs uploaded' });

    const newFiles = [];
    for (const file of req.files) {
      const gridfsId = await uploadBufferToGridFS(file.buffer, file.originalname);
      newFiles.push({ filename: file.originalname, url: `/uploads/${gridfsId}` });
    }

    paper.pdfFiles = paper.pdfFiles || [];
    paper.pdfFiles.push(...newFiles);
    await paper.save();
    res.json({ message: `${req.files.length} PDF(s) uploaded`, pdfFiles: paper.pdfFiles });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/mock-tests/:paperId/syllabus', authMiddleware, adminMiddleware, upload.array('syllabus', 5), async (req, res) => {
  try {
    const paper = await MockTestPaper.findById(req.params.paperId);
    if (!paper) return res.status(404).json({ error: 'Paper not found' });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No syllabus files uploaded' });

    const newFiles = [];
    for (const file of req.files) {
      const gridfsId = await uploadBufferToGridFS(file.buffer, file.originalname);
      newFiles.push({ filename: file.originalname, url: `/uploads/${gridfsId}` });
    }

    paper.syllabusFiles = paper.syllabusFiles || [];
    paper.syllabusFiles.push(...newFiles);
    await paper.save();
    res.json({ message: `${req.files.length} syllabus file(s) uploaded`, syllabusFiles: paper.syllabusFiles });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/mock-tests/:paperId/questions', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const paper = await MockTestPaper.findById(req.params.paperId);
    if (!paper) return res.status(404).json({ error: 'Paper not found' });
    res.json({ questions: paper.questions || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/materials', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const materials = await Material.find().sort({ createdAt: -1 });
    res.json(materials);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/materials/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const material = await Material.findById(req.params.id);
    if (!material) return res.status(404).json({ error: 'Material not found' });
    res.json(material);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/notices', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const notices = await Notice.find().sort({ createdAt: -1 });
    res.json(notices);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/notices', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });
    await Notice.updateMany({}, { active: false });
    const notice = new Notice({ message, active: true });
    await notice.save();
    res.json({ success: true, notice });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/contributions/pending', authMiddleware, adminMiddleware, async (req, res) => {
  // Return empty for now - contributions system not fully implemented
  res.json([]);
});

app.post('/api/admin/contributions/:id/approve', authMiddleware, adminMiddleware, async (req, res) => {
  res.json({ success: true, message: 'Not implemented yet' });
});

app.get('/api/admin/ai-status', authMiddleware, adminMiddleware, (req, res) => {
  res.json({
    aiEnabled,
    aiMockEnabled,
    model: AI_MODEL,
    base: AI_API_BASE,
    groqKeys: AI_API_MOCK_KEYS.length
  });
});

// Alias for frontend compatibility
app.get('/api/admin/ai-mock-status', authMiddleware, adminMiddleware, (req, res) => {
  res.json({
    aiEnabled,
    aiMockEnabled,
    model: AI_MODEL,
    base: AI_API_BASE,
    groqKeys: AI_API_MOCK_KEYS.length
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
