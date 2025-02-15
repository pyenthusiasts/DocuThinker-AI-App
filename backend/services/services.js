const firebaseAdmin = require("firebase-admin");
const fs = require("fs");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const multer = require("multer");
const {
  GoogleAIFileManager,
  FileState,
} = require("@google/generative-ai/server");
require("dotenv").config();

// Parse the private key (ensuring it's correctly formatted)
const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");

// Initialize Firebase Admin using environment variables from .env
firebaseAdmin.initializeApp({
  credential: firebaseAdmin.credential.cert({
    type: process.env.FIREBASE_TYPE,
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: privateKey,
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: process.env.FIREBASE_AUTH_URI,
    token_uri: process.env.FIREBASE_TOKEN_URI,
    auth_provider_x509_cert_url:
      process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
    client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
  }),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});

// Firestore for storing user documents
const firestore = firebaseAdmin.firestore();

// Helper: Create a new user
exports.createUser = async (email, password) => {
  return await firebaseAdmin.auth().createUser({ email, password });
};

// Helper: Login user and generate custom token
exports.loginUser = async (email) => {
  const user = await firebaseAdmin.auth().getUserByEmail(email);
  return await firebaseAdmin.auth().createCustomToken(user.uid);
};

// Helper: Summarize Document using AI
exports.generateSummary = async (file) => {
  let extractedText = "";
  const fileBuffer = fs.readFileSync(file.filepath);

  if (file.mimetype === "application/pdf") {
    const pdfData = await pdfParse(fileBuffer);
    extractedText = pdfData.text;
  } else if (
    file.mimetype ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const docData = await mammoth.extractRawText({ buffer: fileBuffer });
    extractedText = docData.value;
  } else {
    throw new Error("Unsupported file format");
  }

  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    systemInstruction: `${process.env.AI_INSTRUCTIONS}. Your task now is to: Summarize the provided document text in paragraphs (not bullet points).`,
  });

  const chatSession = model.startChat({
    history: [{ role: "user", parts: [{ text: extractedText }] }],
  });
  const result = await chatSession.sendMessage(extractedText);

  if (!result.response || !result.response.text) {
    throw new Error("Failed to generate a summary from the AI");
  }

  return {
    summary: result.response.text(),
    originalText: extractedText,
  };
};

// Multer setup for handling file uploads
const upload = multer({ dest: "uploads/" });

// Helper: Process Audio using Gemini API
exports.processAudio = async (file, context) => {
  const fileBuffer = fs.readFileSync(file.filepath);
  const mimeType = file.mimetype;

  // Accept both "audio/wav", "audio/wave", and "audio/mp3" formats
  if (!["audio/wav", "audio/wave", "audio/mp3"].includes(mimeType)) {
    throw new Error(
      "Unsupported audio format. Please upload a WAV or MP3 file.",
    );
  }

  const fileManager = new GoogleAIFileManager(process.env.GOOGLE_AI_API_KEY);

  // Upload file to Gemini
  const uploadResult = await fileManager.uploadFile(file.filepath, {
    mimeType: mimeType,
    displayName: "User Uploaded Audio",
  });

  let uploadedFile = await fileManager.getFile(uploadResult.file.name);
  while (uploadedFile.state === FileState.PROCESSING) {
    await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait for 10 seconds before re-checking the state
    uploadedFile = await fileManager.getFile(uploadResult.file.name);
  }

  if (uploadedFile.state === FileState.FAILED) {
    throw new Error("Audio processing failed.");
  }

  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  // Generate transcription or summary with context if provided
  const prompt = [
    {
      fileData: {
        fileUri: uploadedFile.uri,
        mimeType: mimeType,
      },
    },
    {
      text: `${process.env.AI_INSTRUCTIONS}. Please respond conversationally to the user and do what the user asks you 
      to do. If the user asks a question, provide a detailed answer.${
        context
          ? " Here is some additional context about the document being referred to by the user. Answer based on this document: " +
            context
          : ""
      }.`,
    },
  ];

  const result = await model.generateContent(prompt);

  if (!result.response || !result.response.text) {
    throw new Error("Failed to generate a summary from the AI");
  }

  return {
    summary: result.response.text(),
  };
};

// Helper: Generate Key Ideas
exports.generateKeyIdeas = async (documentText) => {
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    systemInstruction: `${process.env.AI_INSTRUCTIONS}. Your task now is to: Generate key ideas from the provided text.`,
  });

  const chatSession = model.startChat({
    history: [{ role: "user", parts: [{ text: documentText }] }],
  });
  const result = await chatSession.sendMessage(documentText);
  return result.response.text();
};

// Helper: Generate Discussion Points
exports.generateDiscussionPoints = async (documentText) => {
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    systemInstruction: `${process.env.AI_INSTRUCTIONS}. Your task now is to: Generate discussion points from the provided text.`,
  });

  const chatSession = model.startChat({
    history: [{ role: "user", parts: [{ text: documentText }] }],
  });
  const result = await chatSession.sendMessage(documentText);
  return result.response.text();
};

// In-memory store for conversation history per session
let sessionHistory = {};

// Helper function to validate that the text is a non-empty string
const isValidText = (text) => {
  return typeof text === "string" && text.trim().length > 0;
};

// Helper: Chat with AI Model using originalText as context
exports.chatWithAI = async (sessionId, message, originalText) => {
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    systemInstruction: `${process.env.AI_INSTRUCTIONS}. Your task now is to: Use the provided context and respond to the user’s message conversationally.`,
  });

  // Initialize the conversation history if not present
  if (!sessionHistory[sessionId]) {
    sessionHistory[sessionId] = [];
  }

  // Retrieve the conversation history for this session
  let history = sessionHistory[sessionId];

  // Ensure the originalText is valid for the first message
  if (history.length === 0 && isValidText(originalText)) {
    // Add the original context as the first message from the user
    history.push({ role: "user", parts: [{ text: originalText }] });
  }

  // Ensure the user message is valid
  if (!isValidText(message)) {
    throw new Error("User message must be a non-empty string.");
  }

  // Add the user message to history
  history.push({ role: "user", parts: [{ text: message }] });

  try {
    // Start AI chat session using the accumulated history
    const chatSession = model.startChat({
      history: history, // Pass the conversation history
    });

    const result = await chatSession.sendMessage(message);

    // Ensure that the response contains valid text
    if (!result.response || !result.response.text) {
      throw new Error("Failed to get response from the AI.");
    }

    // Add the AI's response to the conversation history
    history.push({ role: "model", parts: [{ text: result.response.text() }] });

    // Update the session history with the new conversation context
    sessionHistory[sessionId] = history;

    // Return the AI's response
    return result.response.text();
  } catch (error) {
    // Handle potential errors
    throw new Error("Failed to get AI response: " + error.message);
  }
};

// Clear session history (optional function if needed)
exports.clearSessionHistory = (sessionId) => {
  delete sessionHistory[sessionId];
};

// Helper: Check if User Exists and Update Password
exports.verifyUserAndUpdatePassword = async (email, newPassword) => {
  try {
    // Check if the user exists in Firebase
    const user = await firebaseAdmin.auth().getUserByEmail(email);

    // If user exists, update their password
    await firebaseAdmin.auth().updateUser(user.uid, {
      password: newPassword,
    });

    return { message: "Password updated successfully." };
  } catch (error) {
    throw new Error("Failed to update password. " + error.message);
  }
};

// Helper: Verify if User Email Exists
exports.verifyUserEmail = async (email) => {
  try {
    const userRecord = await firebaseAdmin.auth().getUserByEmail(email);
    return userRecord;
  } catch (error) {
    throw new Error("User not found");
  }
};

// Helper: Sentiment Analysis using AI
// Helper: Sentiment Analysis using AI
exports.analyzeSentiment = async (documentText) => {
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    systemInstruction: `${process.env.AI_INSTRUCTIONS}. Your task now is to: Analyze the sentiment of the provided text. Return the result as a JSON object with two properties: "score" between -1 (very negative) to +1 (very positive) and "description" as a brief summary of the sentiment.`,
  });

  const chatSession = model.startChat({
    history: [{ role: "user", parts: [{ text: documentText }] }],
  });
  const result = await chatSession.sendMessage(documentText);

  if (!result.response || !result.response.text) {
    throw new Error("Failed to perform sentiment analysis from the AI");
  }

  // Extract and parse the response text into JSON format
  try {
    let responseText = result.response.text();

    // Strip the ```json and ``` markers if they exist
    responseText = responseText.replace(/```json|```/g, "").trim();

    // Parse the cleaned JSON string
    const response = JSON.parse(responseText);

    return {
      sentimentScore: response.score,
      description: response.description,
    };
  } catch (error) {
    console.error("Error parsing sentiment response:", error);
    throw new Error("Failed to parse sentiment analysis response");
  }
};

// Helper: Generate Summary in Bullet Points
exports.generateBulletSummary = async (documentText) => {
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    systemInstruction: `${process.env.AI_INSTRUCTIONS}. Your task now is to: Summarize the provided document text in bullet points.`,
  });

  const chatSession = model.startChat({
    history: [{ role: "user", parts: [{ text: documentText }] }],
  });
  const result = await chatSession.sendMessage(documentText);

  if (!result.response || !result.response.text) {
    throw new Error("Failed to generate bullet point summary from the AI");
  }

  return result.response.text();
};

// Helper: Generate Summary in Selected Language
exports.generateSummaryInLanguage = async (documentText, language) => {
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    systemInstruction: `${process.env.AI_INSTRUCTIONS}. Your task now is to: Summarize the given text in ${language}.`,
  });

  const chatSession = model.startChat({
    history: [{ role: "user", parts: [{ text: documentText }] }],
  });
  const result = await chatSession.sendMessage(documentText);

  if (!result.response || !result.response.text) {
    throw new Error("Failed to generate translated summary from the AI");
  }

  return result.response.text();
};

// Helper: Content Rewriting or Rephrasing
exports.rewriteContent = async (documentText, style) => {
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    systemInstruction: `${process.env.AI_INSTRUCTIONS}. Your task now is to: Rephrase or rewrite the provided text in a ${style} style.`,
  });

  const chatSession = model.startChat({
    history: [{ role: "user", parts: [{ text: documentText }] }],
  });
  const result = await chatSession.sendMessage(documentText);

  if (!result.response || !result.response.text) {
    throw new Error("Failed to rewrite content using the AI");
  }

  return result.response.text();
};

// Helper: Generate Actionable Recommendations
exports.generateActionableRecommendations = async (documentText) => {
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    systemInstruction: `${process.env.AI_INSTRUCTIONS}. Your task now is to: Generate actionable recommendations or next steps based on the provided text. Focus on identifying follow-up actions, decisions to be made, or critical takeaways.`,
  });

  const chatSession = model.startChat({
    history: [{ role: "user", parts: [{ text: documentText }] }],
  });
  const result = await chatSession.sendMessage(documentText);

  if (!result.response || !result.response.text) {
    throw new Error(
      "Failed to generate actionable recommendations using the AI",
    );
  }

  return result.response.text();
};

// Export endpoints to be used in server routes
module.exports = { firestore, isValidText, sessionHistory, ...exports };
