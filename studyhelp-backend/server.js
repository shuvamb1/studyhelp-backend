// server.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Atlas URI
const uri = 'mongodb+srv://studyadmin:s1ywzQlamDlNFgcI@studyhelp.mi5j40t.mongodb.net/studyhelp?retryWrites=true&w=majority&appName=studyhelp';

// Connect to MongoDB
mongoose.connect(uri)
  .then(() => console.log('✅ Connected to MongoDB Atlas'))
  .catch(err => console.error('❌ Connection error:', err));

// Define Schema
const studentSchema = new mongoose.Schema({
  name: String,
  roll: Number,
  department: String,
  year: String,
  cin: String
});

const Student = mongoose.model('Student', studentSchema);

// Registration endpoint
app.post('/register', async (req, res) => {
  try {
    const { name, roll, department, year, cin } = req.body;

    const existingUser = await Student.findOne({
      $or: [{ cin }]
    });

    if (existingUser) {
      return res.status(400).send('❌ CIN or Roll number already registered.Please go to Sign in');
    }

    const student = new Student({ name, roll, department, year, cin });
    await student.save();
    res.status(201).send('✅ Registration successful');

  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).send('❌ Server error');
  }
});

// Login endpoint
app.post('/login', async (req, res) => {
  const { name, cin } = req.body;

  try {
    const userByCin = await Student.findOne({ cin });

    if (!userByCin) {
      return res.status(401).send('❌ CIN not found');
    }

    if (userByCin.name !== name) {
      return res.status(401).send('❌ Name doesn\'t match with CIN');
    }

    res.status(200).send('✅ Login successful');
  } catch (err) {
    console.error("❌ Login error:", err);
    res.status(500).send('❌ Server error');
  }
});

// ✅ Test route for pinging
app.get('/', (req, res) => {
  res.send('✅ StudyHelp backend is running');
});

// ✅ Start the server on correct port
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
