const express = require('express');
const cors = require('cors');
const app = express();
const { registerUser, loginUser, uploadDocument, generateKeyIdeas, generateDiscussionPoints, chatWithAI } = require('./controller');

app.use(express.json());

// CORS configuration
const corsOptions = {
  origin: ['http://localhost:3001', 'http://localhost:3000', 'https://docuthinker-fullstack-app.vercel.app'],
  methods: ['GET', 'POST'],
  credentials: true
};

app.use(cors(corsOptions));

// Logging Middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Routes
app.post('/register', registerUser);
app.post('/login', loginUser);
app.post('/upload', uploadDocument);
app.post('/generate-key-ideas', generateKeyIdeas);
app.post('/generate-discussion-points', generateDiscussionPoints);
app.post('/chat', chatWithAI);

// Error handling for unsupported routes
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Global error handler:', err.stack);
  res.status(500).json({ error: 'An internal error occurred', details: err.message });
});

// Start the server
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`Server ready on port ${port}.`);
});

module.exports = app;
