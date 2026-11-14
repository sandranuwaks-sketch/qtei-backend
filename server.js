const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Database connection using Render/Railway environment variable
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Test endpoint
app.get('/', (req, res) => {
  res.send('QTEI LMS Backend is running!');
});

// Get all students
app.get('/api/students', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM students');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a student
app.post('/api/students', async (req, res) => {
  const { name, email, course, code } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO students (name, email, course, code, status, progress) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [name, email, course, code, 'Admitted', 10]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));