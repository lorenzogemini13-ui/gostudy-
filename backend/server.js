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

// Helper to save study plan to a JSON file
const savePlanToFile = async (userId, generationId, studyPlan) => {
    const dir = path.join(__dirname, 'saved_plans', userId);
    try {
        await fsPromises.mkdir(dir, { recursive: true });
        const filePath = path.join(dir, `${generationId}.json`);
        await fsPromises.writeFile(filePath, JSON.stringify(studyPlan, null, 2));
        return filePath;
    } catch (err) {
        console.error(`Failed to save plan to file for user ${userId}:`, err.message);
        throw err;
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

        // 4. optimized system prompt (v3 - enhanced with difficulty, hints, and concept mapping)
        // this prompt instructs the ai to generate a comprehensive study plan with:
        // - difficulty ratings (1-5) for active recall questions
        // - optional hints for difficult topics in spaced repetition
        // - concept mapping for key relationships between ideas
        const systemPrompt = `You are an expert AI Study Assistant.
Analyze the provided text and generate a structured study plan in JSON format.

GOALS:
1. SUMMARY: Provide a high-density executive summary (MAX 80 words).
2. ACTIVE RECALL: Generate 3-5 high-yield questions.
   - Each question must include a difficulty_rating from 1 (easy) to 5 (very hard).
   - Answers MUST be extremely concise (MAX 2 sentences per answer).
3. SPACED REPETITION: Create a 4-step schedule (Day 1, 3, 7, 14).
   - For topics with difficulty >= 4, include an optional hint to aid recall.
4. CONCEPT MAP: Generate a list of key concepts with their relationships.
   - Each concept should link to related concepts (MAX 5 concepts).
5. MEMORY PALACE: Describe a vivid spatial mnemonic for the single most complex concept (MAX 100 words).

CONSTRAINTS:
- Use valid JSON only.
- Follow the snake_case schema EXACTLY (all keys must be lowercase with underscores).
- NO preambles or explanations outside the JSON.
- BE CONCISE. Every word must add value.

SCHEMA:
{
  "summary": "string",
  "active_recall": [
    {
      "question": "string",
      "answer": "string",
      "difficulty_rating": 1-5
    }
  ],
  "spaced_repetition": [
    {
      "day": "string",
      "topic": "string",
      "hint": "string or null (optional, for difficult topics)"
    }
  ],
  "concept_map": [
    {
      "concept": "string",
      "related_to": ["string"],
      "relationship_type": "string (e.g., 'is part of', 'depends on', 'contrasts with')"
    }
  ],
  "memory_palace": "string"
}`;

        console.log('Sending to Perplexity AI...');
        
        // api request to perplexity with increased token limit for enhanced response
        const response = await axios.post('https://api.perplexity.ai/chat/completions', {
            model: 'sonar-pro', 
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Analyze this material and generate the study plan accordingly:\n\n${truncatedText}` }
            ],
            temperature: 0.2,
            max_tokens: 4000 // increased to accommodate concept map and hints
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 60000 // 60 second timeout for robustness
        });

        // 5. robust json parsing with comprehensive error handling
        // handles various ai response formats and validates schema compliance
        let content = response.data?.choices?.[0]?.message?.content;
        
        // validate that we received content from the api
        if (!content || typeof content !== 'string') {
            console.error("Invalid API response structure:", JSON.stringify(response.data));
            throw new Error("AI response was empty or malformed. Please try again.");
        }
        
        // remove markdown code blocks if present (handles ```json and ``` wrappers)
        content = content.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        
        // extract json object if ai includes preamble text before the json
        let jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            content = jsonMatch[0];
        } else {
            console.error("No JSON object found in AI response:", content);
            throw new Error("AI response did not contain valid JSON. Please try again.");
        }

        let studyPlan;
        try {
            studyPlan = JSON.parse(content);
            
            // validate required fields exist in the response
            const requiredFields = ['summary', 'active_recall', 'spaced_repetition', 'memory_palace'];
            const missingFields = requiredFields.filter(field => !studyPlan[field]);
            
            if (missingFields.length > 0) {
                throw new Error(`Invalid response structure: missing fields - ${missingFields.join(', ')}`);
            }
            
            // validate active_recall has difficulty ratings and normalize structure
            // ensures each question has a valid difficulty_rating between 1-5
            if (Array.isArray(studyPlan.active_recall)) {
                studyPlan.active_recall = studyPlan.active_recall.map((item, index) => {
                    const rating = parseInt(item.difficulty_rating, 10);
                    return {
                        question: item.question || `Question ${index + 1}`,
                        answer: item.answer || 'No answer provided',
                        difficulty_rating: (rating >= 1 && rating <= 5) ? rating : 3 // default to medium difficulty
                    };
                });
            }
            
            // validate spaced_repetition has hints where appropriate
            // adds null hint if not provided for consistency
            if (Array.isArray(studyPlan.spaced_repetition)) {
                studyPlan.spaced_repetition = studyPlan.spaced_repetition.map(item => ({
                    day: item.day || 'Day 1',
                    topic: item.topic || 'Review topic',
                    hint: item.hint || null // ensure hint field exists, even if null
                }));
            }
            
            // validate concept_map exists and has proper structure
            // provides empty array if not present for backwards compatibility
            if (!studyPlan.concept_map || !Array.isArray(studyPlan.concept_map)) {
                studyPlan.concept_map = [];
            } else {
                studyPlan.concept_map = studyPlan.concept_map.map(item => ({
                    concept: item.concept || 'Unknown concept',
                    related_to: Array.isArray(item.related_to) ? item.related_to : [],
                    relationship_type: item.relationship_type || 'relates to'
                }));
            }
            
        } catch (jsonError) {
            // detailed error logging for debugging json parsing issues
            console.error("JSON Parse Error:", jsonError.message);
            console.error("Raw AI Output (first 500 chars):", content.substring(0, 500));
            throw new Error(`AI response parsing failed: ${jsonError.message}. Please try again.`);
        }

        console.log('✅ Plan generated successfully!');

        // 6. Save to Firestore if user is authenticated
        if (req.headers.authorization && db) {
            try {
                const authHeader = req.headers.authorization;
                const idToken = authHeader.split('Bearer ')[1];
                const decodedToken = await admin.auth().verifyIdToken(idToken);
                
                const docRef = await db.collection('generations').add({
                    userId: decodedToken.uid,
                    fileName: req.file.originalname,
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
                
                // Save to disk using the Firestore ID as filename
                await savePlanToFile(decodedToken.uid, docRef.id, studyPlan);
                console.log('💾 Plan saved to Firestore and disk for user:', decodedToken.uid);
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
            .get();

        const generations = [];
        snapshot.forEach(doc => {
            generations.push({ id: doc.id, ...doc.data() });
        });

        // Sort client-side to avoid requiring a composite index
        generations.sort((a, b) => {
            const dateA = a.createdAt?._seconds || 0;
            const dateB = b.createdAt?._seconds || 0;
            return dateB - dateA;
        });

        res.json(generations.slice(0, 100));
    } catch (error) {
        console.error('Error fetching generations:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ error: error.message });
    }
});

// Get a specific generation (including file content)
app.get('/api/generations/:id', authenticate, async (req, res) => {
    if (!db) return res.status(500).json({ error: 'Firestore not initialized' });

    try {
        const doc = await db.collection('generations').doc(req.params.id).get();
        if (!doc.exists || doc.data().userId !== req.user.uid) {
            return res.status(404).json({ error: 'Generation not found' });
        }

        const data = doc.data();
        const filePath = path.join(__dirname, 'saved_plans', req.user.uid, `${doc.id}.json`);
        
        try {
            const fileContent = await fsPromises.readFile(filePath, 'utf-8');
            const studyPlan = JSON.parse(fileContent);
            res.json({ id: doc.id, ...data, studyPlan });
        } catch (fileError) {
            console.error('Error reading saved plan file:', fileError);
            res.status(500).json({ error: 'Failed to read plan file' });
        }
    } catch (error) {
        console.error('Error fetching generation:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete a specific generation
app.delete('/api/generations/:id', authenticate, async (req, res) => {
    if (!db) return res.status(500).json({ error: 'Firestore not initialized' });

    try {
        const docRef = db.collection('generations').doc(req.params.id);
        const doc = await docRef.get();
        if (!doc.exists || doc.data().userId !== req.user.uid) {
            return res.status(404).json({ error: 'Generation not found' });
        }

        // 1. Delete Firestore record
        await docRef.delete();

        // 2. Delete file from disk
        const filePath = path.join(__dirname, 'saved_plans', req.user.uid, `${doc.id}.json`);
        await safeDelete(filePath);

        res.json({ message: 'Generation deleted successfully' });
    } catch (error) {
        console.error('Error deleting generation:', error);
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

// --- 7. NEW DASHBOARD ENDPOINTS (MOCK) ---

app.get('/api/courses', authenticate, (req, res) => {
    // Return mock courses
    res.json([
        { id: 1, title: 'My First Course', progress: 0 },
        { id: 2, title: 'Advanced Calculus', progress: 35 },
        { id: 3, title: 'World History', progress: 80 }
    ]);
});

app.get('/api/stats', authenticate, (req, res) => {
     res.json({
        streak: 10,
        gems: 50,
        hearts: 5,
        xp: 1250
     });
});

app.get('/api/notifications', authenticate, (req, res) => {
    res.json([
        { id: 1, text: "Welcome to your new dashboard!", read: false },
        { id: 2, text: "Don't forget your daily goal.", read: false }
    ]);
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