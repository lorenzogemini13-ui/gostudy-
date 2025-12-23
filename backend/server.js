const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const fsPromises = require('fs').promises; // Use promises for async safety
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const axios = require('axios');

// --- 1. CONFIGURATION & VALIDATION ---
if (!process.env.PERPLEXITY_API_KEY) {
    console.error("CRITICAL ERROR: process.env.PERPLEXITY_API_KEY is missing.");
    process.exit(1);
}

const app = express();

// --- 2. SECURITY & LIMITS ---
// Allow all origins (dev) or restrict in production
app.use(cors({ origin: '*' })); 
app.use(express.json());

// --- 3. FIREBASE ADMIN INITIALIZATION ---
const admin = require('firebase-admin');

// Initialize Firebase Admin via environment variable or default
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("Firebase Admin initialized via FIREBASE_SERVICE_ACCOUNT");
    } catch (e) {
        console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT JSON:", e);
    }
} else {
    try {
        // Explicitly set Project ID for local dev (allows verifyIdToken to work without key file)
        admin.initializeApp({
            projectId: "gostudy-7334c"
        });
        console.log("Firebase Admin initialized via default credentials with Project ID");
    } catch (e) {
        console.warn("Firebase Admin NOT initialized. Auth features will be disabled.");
    }
}

const db = admin.apps.length ? admin.firestore() : null;

// Middleware to verify Firebase ID Token
const authenticate = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = decodedToken;
        next();
    } catch (error) {
        console.error('Error verifying token:', error);
        res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
};

// Limit upload size to 5MB to prevent memory exhaustion
const upload = multer({ 
    dest: '/tmp/',
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// --- 3. HELPER FUNCTIONS ---

// Safely delete file without crashing if it's already gone
const safeDelete = async (path) => {
    try {
        await fsPromises.unlink(path);
    } catch (err) {
        // Ignore "file not found" errors, log others
        if (err.code !== 'ENOENT') console.error(`Failed to delete temp file ${path}:`, err.message);
    }
};

// Robust text extraction with guaranteed cleanup
const extractText = async (file) => {
    const filePath = file.path;
    let extractedText = '';
    
    try {
        const buffer = await fsPromises.readFile(filePath);

        if (file.mimetype === 'application/pdf') {
            const data = await pdf(buffer);
            extractedText = data.text;
        } else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            const result = await mammoth.extractRawText({ path: filePath });
            extractedText = result.value;
        } else if (file.mimetype === 'text/plain') {
            extractedText = buffer.toString('utf-8');
        } else {
            throw new Error('Unsupported file type. Must be PDF, DOCX, or TXT.');
        }
        
        return extractedText;
    } finally {
        // CLEANUP: Guaranteed to run after extraction attempt
        await safeDelete(filePath);
    }
};

// --- 4. API ROUTE ---

app.post('/api/generate-plan', upload.single('document'), async (req, res) => {
    // 1. Validation
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded or file too large (>5MB).' });
    }

    console.log(`\n--- Processing: ${req.file.originalname} ---`);

    try {
        // 2. Extraction
        let documentText = await extractText(req.file);
        
        // Remove non-printable characters
        documentText = documentText.replace(/[\x00-\x09\x0B-\x0C\x0E-\x1F\x7F]/g, '');

        if (!documentText || documentText.trim().length < 50) {
            throw new Error("Document text is empty or too short. If this is a scanned PDF, please use OCR.");
        }

        console.log(`Extracted ${documentText.length} characters.`);

        // 3. Truncation (Safe Token Limits)
        // Approx 15k tokens to leave room for the answer
        const truncatedText = documentText.substring(0, 60000); 

        // 4. Optimized System Prompt (v2 - Strict Conciseness)
        const systemPrompt = `You are an expert AI Study Assistant.
Analyze the provided text and generate a structured study plan in JSON format.

GOALS:
1. SUMMARY: Provide a high-density executive summary (MAX 80 words).
2. ACTIVE RECALL: Generate 3-5 high-yield questions. 
   - Answers MUST be extremely concise (MAX 2 sentences per answer).
3. SPACED REPETITION: Create a 4-step schedule (Day 1, 3, 7, 14).
4. MEMORY PALACE: Describe a vivid spatial mnemonic for the single most complex concept (MAX 100 words).

CONSTRAINTS:
- Use valid JSON only.
- Follow the snake_case schema exactly.
- NO preambles or explanations.
- BE CONCISE. Every word must add value.

SCHEMA:
{
  "summary": "string",
  "active_recall": [{"question": "string", "answer": "string"}],
  "spaced_repetition": [{"day": "string", "topic": "string"}],
  "memory_palace": "string"
}`;

        console.log('Sending to Perplexity AI...');
        
        const response = await axios.post('https://api.perplexity.ai/chat/completions', {
            model: 'sonar-pro', 
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Analyze this material and generate the study plan accordingly:\n\n${truncatedText}` }
            ],
            temperature: 0.2,
            max_tokens: 3000
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        // 5. Robust JSON Parsing
        let content = response.data.choices[0].message.content;
        
        // Remove markdown code blocks if present
        content = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        
        // Extract JSON object if AI includes preamble text
        let jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            content = jsonMatch[0];
        }

        let studyPlan;
        try {
            studyPlan = JSON.parse(content);
            
            // Validate required fields
            if (!studyPlan.summary || !studyPlan.active_recall || !studyPlan.spaced_repetition || !studyPlan.memory_palace) {
                throw new Error('Invalid response structure: missing required fields');
            }
        } catch (jsonError) {
            console.error("JSON Parse Error. AI Output:", content);
            throw new Error("AI response was invalid. Please try again.");
        }

        console.log('✅ Plan generated successfully!');

        // 6. Save to Firestore if user is authenticated
        if (req.headers.authorization && db) {
            try {
                const authHeader = req.headers.authorization;
                const idToken = authHeader.split('Bearer ')[1];
                const decodedToken = await admin.auth().verifyIdToken(idToken);
                
                await db.collection('generations').add({
                    userId: decodedToken.uid,
                    fileName: req.file.originalname,
                    studyPlan: studyPlan,
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log('💾 Plan saved to Firestore for user:', decodedToken.uid);
            } catch (authError) {
                console.error('Failed to save to Firestore (possibly invalid token):', authError.message);
                // We still return the plan to the user even if saving fails
            }
        }

        res.json(studyPlan);

    } catch (error) {
        console.error('❌ Error details:', error);
        console.error('Stack:', error.stack);
        
        // Handle specific Axios errors (API limits, auth)
        if (error.response) {
            console.error('API Response Status:', error.response.status);
            console.error('API Response Data:', error.response.data);
            return res.status(error.response.status).json({ 
                error: 'AI Provider Error', 
                details: error.response.data,
                message: error.message
            });
        }

        res.status(500).json({ error: error.message });
    }
});

// --- 5. HISTORY ROUTE ---

app.get('/api/generations', authenticate, async (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Firestore not initialized' });
    }

    try {
        const snapshot = await db.collection('generations')
            .where('userId', '==', req.user.uid)
            .orderBy('createdAt', 'desc')
            .limit(20)
            .get();

        const generations = [];
        snapshot.forEach(doc => {
            generations.push({ id: doc.id, ...doc.data() });
        });

        res.json(generations);
    } catch (error) {
        console.error('Error fetching generations:', error);
        res.status(500).json({ error: error.message });
    }
});

// --- 6. PROFILE & ACCOUNT MANAGEMENT ---

// Update Profile (Display Name, Photo URL)
app.put('/api/profile', authenticate, async (req, res) => {
    try {
        const { displayName, photoURL } = req.body;
        const updates = {};
        if (displayName !== undefined) updates.displayName = displayName;
        if (photoURL !== undefined) updates.photoURL = photoURL;

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        await admin.auth().updateUser(req.user.uid, updates);
        console.log(`Updated profile for user: ${req.user.uid}`);
        res.json({ message: 'Profile updated successfully' });
    } catch (error) {
        console.error('Error updating profile:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update Account (Email, Password) - Requires sensitive actions to be verified on client first
app.put('/api/account', authenticate, async (req, res) => {
    try {
        const { email, password } = req.body;
        const updates = {};
        if (email) updates.email = email;
        if (password) updates.password = password;

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        await admin.auth().updateUser(req.user.uid, updates);
        console.log(`Updated account credentials for user: ${req.user.uid}`);
        res.json({ message: 'Account updated successfully' });
    } catch (error) {
        console.error('Error updating account:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete Account
app.delete('/api/account', authenticate, async (req, res) => {
    try {
        await admin.auth().deleteUser(req.user.uid);
        
        // Optional: Delete user data from Firestore
        if (db) {
             const batch = db.batch();
             const snapshot = await db.collection('generations').where('userId', '==', req.user.uid).get();
             snapshot.forEach(doc => {
                 batch.delete(doc.ref);
             });
             await batch.commit();
             console.log(`Deleted user data for: ${req.user.uid}`);
        }

        console.log(`Deleted user: ${req.user.uid}`);
        res.json({ message: 'Account deleted successfully' });
    } catch (error) {
        console.error('Error deleting account:', error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`------------------------------------------------`);
    console.log(`🚀 GoStudy Backend running on port ${PORT}`);
    console.log(`------------------------------------------------`);
});