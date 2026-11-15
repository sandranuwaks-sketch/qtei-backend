const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const ADMIN_EMAIL = 'sandranuwaks@gmail.com';
const FRONTEND_URL = 'https://qtei-lms.vercel.app';

// PostgreSQL Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Free Nodemailer Transporter via Gmail App Password
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Helper to send emails safely
async function sendEmail(to, subject, html) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('Email credentials missing; skipping email to:', to);
    return;
  }
  await transporter.sendMail({
    from: `"QTEI LMS Portal" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    html
  });
}

// Auto-create database tables if they do not exist
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS courses (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      timetable TEXT DEFAULT 'Mon & Wed: 10:00 AM - 12:00 PM WAT'
    );
    CREATE TABLE IF NOT EXISTS tutors (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      code TEXT UNIQUE NOT NULL,
      course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      code TEXT UNIQUE NOT NULL,
      course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
      bio TEXT DEFAULT '',
      phone TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS magic_links (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL
    );
    CREATE TABLE IF NOT EXISTS timetable_requests (
      id SERIAL PRIMARY KEY,
      course_id INTEGER REFERENCES courses(id) ON DELETE CASCADE,
      tutor_name TEXT NOT NULL,
      proposed_timetable TEXT NOT NULL,
      status TEXT DEFAULT 'pending'
    );
  `);
}
initDB().catch(err => console.error('DB Init Error:', err));

// Helper for magic link generation
async function createAndEmailMagicLink(email, role, extraWelcomeHtml = '') {
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

  await pool.query(
    'INSERT INTO magic_links (token, email, role, expires_at) VALUES ($1, $2, $3, $4)',
    [token, email.toLowerCase(), role, expiresAt]
  );

  const link = `${FRONTEND_URL}/?token=${token}`;
  
  const html = `
    <div style="font-family: sans-serif; max-width: 520px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
      <h2 style="color: #4f46e5;">QTEI LMS Portal Access</h2>
      ${extraWelcomeHtml}
      <p>Click the secure sign-in button below to access your <strong>${role.toUpperCase()}</strong> dashboard:</p>
      <a href="${link}" style="display: inline-block; background: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; margin: 16px 0;">
        Sign In to QTEI Portal
      </a>
    </div>
  `;

  sendEmail(email, `Your QTEI LMS ${role.toUpperCase()} Sign-In Link`, html).catch(err => {
    console.log('Background email delivery note:', err.message);
  });

  return link;
}

// 1. FETCH ALL INITIAL DATA
app.get('/api/data', async (req, res) => {
  try {
    const courses = await pool.query('SELECT * FROM courses ORDER BY id ASC');
    const tutors = await pool.query(`
      SELECT t.*, c.name AS course_name, c.code AS course_code 
      FROM tutors t LEFT JOIN courses c ON t.course_id = c.id 
      ORDER BY t.id ASC
    `);
    const students = await pool.query(`
      SELECT s.*, c.name AS course_name, c.code AS course_code, c.timetable 
      FROM students s LEFT JOIN courses c ON s.course_id = c.id 
      ORDER BY s.id ASC
    `);
    const requests = await pool.query(`
      SELECT r.*, c.name AS course_name, c.code AS course_code 
      FROM timetable_requests r JOIN courses c ON r.course_id = c.id 
      WHERE r.status = 'pending' 
      ORDER BY r.id DESC
    `);
    res.json({
      courses: courses.rows,
      tutors: tutors.rows,
      students: students.rows,
      timetableRequests: requests.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. COURSES & TUTORS & STUDENTS CREATION
app.post('/api/courses', async (req, res) => {
  const { name, timetable } = req.body;
  if (!name) return res.status(400).json({ error: 'Course name is required' });
  const code = `CRS-${name.replace(/[^a-zA-Z]/g, '').substring(0, 3).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;
  try {
    const result = await pool.query(
      'INSERT INTO courses (name, code, timetable) VALUES ($1, $2, $3) RETURNING *',
      [name, code, timetable || 'Mon & Wed: 10:00 AM - 12:00 PM WAT']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tutors', async (req, res) => {
  const { name, email, courseId } = req.body;
  if (!name || !email || !courseId) {
    return res.status(400).json({ error: 'Name, email, and an existing course are required.' });
  }
  const code = `TUT-${Math.floor(1000 + Math.random() * 9000)}`;
  try {
    const courseRes = await pool.query('SELECT * FROM courses WHERE id = $1', [courseId]);
    if (courseRes.rows.length === 0) return res.status(404).json({ error: 'Selected course does not exist.' });

    const result = await pool.query(
      'INSERT INTO tutors (name, email, code, course_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, email.toLowerCase(), code, courseId]
    );

    createAndEmailMagicLink(email.toLowerCase(), 'tutor', `<p>You have been assigned as an instructor. Your access code is <strong>${code}</strong>.</p>`).catch(() => {});

    res.json({ 
      ...result.rows[0], 
      course_name: courseRes.rows[0].name, 
      course_code: courseRes.rows[0].code,
      tempCode: code 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/students', async (req, res) => {
  const { name, email, courseId } = req.body;
  if (!name || !email || !courseId) {
    return res.status(400).json({ error: 'Name, email, and course are required.' });
  }
  const code = `QTEI-${Math.floor(10000 + Math.random() * 90000)}`;
  try {
    const courseRes = await pool.query('SELECT * FROM courses WHERE id = $1', [courseId]);
    if (courseRes.rows.length === 0) return res.status(404).json({ error: 'Course not found.' });

    const result = await pool.query(
      'INSERT INTO students (name, email, code, course_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, email.toLowerCase(), code, courseId]
    );

    res.json({
      ...result.rows[0],
      course_name: courseRes.rows[0].name,
      course_code: courseRes.rows[0].code
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. AUTHENTICATION ROUTES
app.post('/api/auth/request-link', async (req, res) => {
  const { email, role } = req.body;
  if (!role) return res.status(400).json({ error: 'Role is required.' });

  try {
    if (role === 'admin') {
      return res.json({ user: { role: 'admin', email: ADMIN_EMAIL } });
    }

    const cleanEmail = (email || '').trim().toLowerCase();
    if (!cleanEmail) return res.status(400).json({ error: 'Email is required.' });

    if (role === 'tutor') {
      const check = await pool.query('SELECT id FROM tutors WHERE email = $1', [cleanEmail]);
      if (check.rows.length === 0) return res.status(404).json({ error: 'No tutor account found with this email.' });
    } else if (role === 'student') {
      const check = await pool.query('SELECT id FROM students WHERE email = $1', [cleanEmail]);
      if (check.rows.length === 0) return res.status(404).json({ error: 'No student account found with this email.' });
    }

    const devLink = await createAndEmailMagicLink(cleanEmail, role);
    res.json({ message: `Magic link generated successfully!`, devLink });
  } catch (err) {
    res.status(500).json({ error: 'Failed: ' + err.message });
  }
});

app.post('/api/auth/verify-token', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required.' });
  try {
    const linkRes = await pool.query('SELECT * FROM magic_links WHERE token = $1', [token]);
    if (linkRes.rows.length === 0) return res.status(401).json({ error: 'Invalid or already used sign-in link.' });
    
    const record = linkRes.rows[0];
    await pool.query('DELETE FROM magic_links WHERE token = $1', [token]);
    
    if (new Date(record.expires_at) < new Date()) {
      return res.status(401).json({ error: 'Sign-in link has expired.' });
    }

    let profile = { email: record.email, role: record.role };
    if (record.role === 'tutor') {
      const tRes = await pool.query('SELECT t.*, c.name AS course_name, c.code AS course_code, c.timetable FROM tutors t LEFT JOIN courses c ON t.course_id = c.id WHERE t.email = $1', [record.email]);
      profile = { ...profile, ...tRes.rows[0] };
    } else if (record.role === 'student') {
      const sRes = await pool.query('SELECT s.*, c.name AS course_name, c.code AS course_code, c.timetable FROM students s LEFT JOIN courses c ON s.course_id = c.id WHERE s.email = $1', [record.email]);
      profile = { ...profile, ...sRes.rows[0] };
    }

    res.json({ user: profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/code-login', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Access code is required.' });
  try {
    const sRes = await pool.query('SELECT s.*, c.name AS course_name, c.code AS course_code, c.timetable FROM students s LEFT JOIN courses c ON s.course_id = c.id WHERE UPPER(s.code) = $1', [code.trim().toUpperCase()]);
    if (sRes.rows.length === 0) return res.status(401).json({ error: 'Invalid Student Access Code.' });
    res.json({ user: { ...sRes.rows[0], role: 'student' } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. STUDENT PROFILE & TIMETABLE
app.put('/api/students/:id/profile', async (req, res) => {
  const { bio, phone } = req.body;
  try {
    const result = await pool.query(
      'UPDATE students SET bio = $1, phone = $2 WHERE id = $3 RETURNING *',
      [bio || '', phone || '', req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/timetable/propose', async (req, res) => {
  const { courseId, tutorName, proposedTimetable } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO timetable_requests (course_id, tutor_name, proposed_timetable) VALUES ($1, $2, $3) RETURNING *',
      [courseId, tutorName, proposedTimetable]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/timetable/approve/:requestId', async (req, res) => {
  try {
    const reqRes = await pool.query('SELECT * FROM timetable_requests WHERE id = $1', [req.params.requestId]);
    if (reqRes.rows.length === 0) return res.status(404).json({ error: 'Request not found.' });
    
    const request = reqRes.rows[0];
    await pool.query('UPDATE courses SET timetable = $1 WHERE id = $2', [request.proposed_timetable, request.course_id]);
    await pool.query("UPDATE timetable_requests SET status = 'approved' WHERE id = $1", [request.id]);
    
    res.json({ message: 'Timetable updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`QTEI Backend running on port ${PORT}`));
