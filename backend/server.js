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
const Tesseract = require('tesseract.js');

// --- 1. CONFIGURATION & VALIDATION ---
if (!process.env.PERPLEXITY_API_KEY) {
    console.error("CRITICAL ERROR: process.env.PERPLEXITY_API_KEY is missing.");
    process.exit(1);
}

const app = express();

// --- 2. SECURITY & LIMITS ---
// Allow all origins (dev) or restrict in production
const ALLOWED_ORIGINS = [
    'http://localhost:3000',
    'http://localhost:5000',
    'http://localhost:5500',
    'http://127.0.0.1:3000',
    'https://go-study-backend.onrender.com',
    'https://gostudy-test.vercel.app'
];

// Supported image MIME types for OCR
const IMAGE_MIMETYPES = [
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/gif',
    'image/bmp'
];

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        if (ALLOWED_ORIGINS.indexOf(origin) === -1) {
            const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    }
}));
app.use(express.json());

// --- ZOD VALIDATION SCHEMAS ---
const { z } = require('zod');

const StudyPlanSchema = z.object({
    summary: z.string().max(10000, "Summary too long"),
    learning_objectives: z.array(z.string()).min(3).max(5).optional(),
    memory_palace: z.string().max(5000, "Memory palace too long"),
    worked_examples: z.array(z.object({
        subtopic: z.string().optional(),
        given_data: z.string(),
        step_by_step_reasoning: z.array(z.string()),
        final_result: z.string()
    })).optional(),
    common_mistakes: z.array(z.object({
        mistake: z.string(),
        explanation: z.string()
    })).optional(),
    active_recall: z.array(z.object({
        question: z.string().max(500),
        answer: z.string().max(2000),
        difficulty_rating: z.union([z.number().min(1).max(5), z.string()]).optional(),
        level: z.number().min(1).max(3).optional(),
        type: z.enum(["multiple_choice", "short_answer"]).optional(),
        options: z.array(z.string()).optional(),
        related_concept: z.string().optional()
    })).max(50, "Too many questions"),
    spaced_repetition: z.array(z.object({
        day: z.string(),
        topic: z.string().max(200),
        hint: z.string().nullable().optional()
    })).max(20),
    concept_map: z.object({
        main_topic: z.string().max(200),
        subtopics: z.array(z.string().max(200)).max(20)
    })
});

// --- CONFIG ENDPOINT (SECURELY SERVE PUBLIC KEYS) ---
app.get('/api/config/auth', (req, res) => {
    // Only return PUBLIC keys needed for client-side Firebase init
    res.json({
        apiKey: process.env.FIREBASE_API_KEY,
        authDomain: process.env.FIREBASE_AUTH_DOMAIN,
        projectId: process.env.FIREBASE_PROJECT_ID,
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
        messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
        appId: process.env.FIREBASE_APP_ID,
        measurementId: process.env.FIREBASE_MEASUREMENT_ID
    });
});

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
        } else if (IMAGE_MIMETYPES.includes(file.mimetype)) {
            // OCR extraction for image files using Tesseract.js
            console.log(`📷 Starting OCR extraction for image: ${file.originalname}`);
            extractedText = await extractTextFromImage(filePath);
            console.log(`✅ OCR completed. Extracted ${extractedText.length} characters.`);
        } else {
            throw new Error('Unsupported file type. Must be PDF, DOCX, TXT, or an image (PNG, JPG, WEBP).');
        }
        
        return extractedText;
    } finally {
        // CLEANUP: Guaranteed to run after extraction attempt
        await safeDelete(filePath);
    }
};

// OCR text extraction from images using Tesseract.js
const extractTextFromImage = async (filePath) => {
    try {
        const { data: { text } } = await Tesseract.recognize(
            filePath,
            'eng', // English language model
            {
                logger: m => {
                    if (m.status === 'recognizing text') {
                        console.log(`OCR Progress: ${Math.round((m.progress || 0) * 100)}%`);
                    }
                }
            }
        );
        
        if (!text || text.trim().length === 0) {
            throw new Error('No text could be extracted from the image. Please ensure the image contains readable text.');
        }
        
        return text.trim();
    } catch (error) {
        console.error('OCR extraction failed:', error.message);
        throw new Error('Failed to extract text from image. Please ensure the image is clear and contains readable text.');
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

// --- 4. PRODUCTION-SAFE CREDITS SYSTEM ---

// Plan credits configuration
const PLAN_CREDITS = {
    free: 3,    // 3 LIFETIME credits for free users (not monthly)
    pro: 40     // 40 credits per month for Pro users
};

// PayPal API Configuration
const PAYPAL_CONFIG = {
    clientId: process.env.PAYPAL_CLIENT_ID,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET,
    webhookId: process.env.PAYPAL_WEBHOOK_ID,
    apiBase: process.env.NODE_ENV === 'production' 
        ? 'https://api-m.paypal.com' 
        : 'https://api-m.sandbox.paypal.com'
};

// Get PayPal access token for API calls
const getPayPalAccessToken = async () => {
    const auth = Buffer.from(`${PAYPAL_CONFIG.clientId}:${PAYPAL_CONFIG.clientSecret}`).toString('base64');
    
    const response = await axios.post(
        `${PAYPAL_CONFIG.apiBase}/v1/oauth2/token`,
        'grant_type=client_credentials',
        {
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        }
    );
    
    return response.data.access_token;
};

// Verify PayPal webhook signature
const verifyPayPalWebhook = async (headers, body) => {
    if (!PAYPAL_CONFIG.clientId || !PAYPAL_CONFIG.webhookId) {
        console.error('⚠️ PayPal credentials not configured. Webhook verification FAILED.');
        return false;
    }
    
    try {
        const accessToken = await getPayPalAccessToken();
        
        const verifyPayload = {
            auth_algo: headers['paypal-auth-algo'],
            cert_url: headers['paypal-cert-url'],
            transmission_id: headers['paypal-transmission-id'],
            transmission_sig: headers['paypal-transmission-sig'],
            transmission_time: headers['paypal-transmission-time'],
            webhook_id: PAYPAL_CONFIG.webhookId,
            webhook_event: body
        };
        
        const response = await axios.post(
            `${PAYPAL_CONFIG.apiBase}/v1/notifications/verify-webhook-signature`,
            verifyPayload,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        return response.data.verification_status === 'SUCCESS';
    } catch (error) {
        console.error('PayPal webhook verification failed:', error.message);
        return false;
    }
};

// Check if webhook event was already processed (idempotency)
const isWebhookProcessed = async (eventId) => {
    if (!db) return false;
    
    const doc = await db.collection('processed_webhooks').doc(eventId).get();
    return doc.exists;
};

// Mark webhook event as processed
const markWebhookProcessed = async (eventId, eventType) => {
    if (!db) return;
    
    await db.collection('processed_webhooks').doc(eventId).set({
        eventId,
        eventType,
        processedAt: admin.firestore.FieldValue.serverTimestamp()
    });
};

// Get user's credits balance (with auto-initialization)
const getCreditsBalance = async (userId) => {
    if (!db) return null;
    
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) {
        // Initialize new user with free plan credits
        const newUserData = {
            plan: 'free',
            credits_balance: PLAN_CREDITS.free,
            paypalSubscriptionId: null,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };
        await userRef.set(newUserData);
        
        // Log initial grant in ledger
        await db.collection('credits_ledger').add({
            userId,
            amount: PLAN_CREDITS.free,
            type: 'grant',
            description: 'Initial free plan credits',
            idempotencyKey: `init_${userId}`,
            paypalEventId: null,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        return { ...newUserData, id: userId };
    }
    
    const userData = userDoc.data();

    // Fix for manual plan changes in Firebase Console
    // If admin sets plan='pro' manually, balance remains at 3 (free). This fixes it to 40.
    if (userData.plan === 'pro' && !userData.paypalSubscriptionId && !userData.manualProCreditsGranted) {
        const newBalance = PLAN_CREDITS.pro;
        
        // Update DB
        await userRef.update({
            credits_balance: newBalance,
            manualProCreditsGranted: true
        });
        
        console.log(`🔧 Auto-corrected credits for manual Pro user ${userId} to ${newBalance}`);
        
        return { ...userData, credits_balance: newBalance, manualProCreditsGranted: true, id: userId };
    }

    return { ...userData, id: userId };
};

// Deduct credits atomically with transaction (returns success/failure)
const deductCredits = async (userId, amount, description, idempotencyKey) => {
    if (!db) return { success: false, error: 'Database not initialized' };
    
    // Check idempotency first
    const existingLedger = await db.collection('credits_ledger')
        .where('idempotencyKey', '==', idempotencyKey)
        .limit(1)
        .get();
    
    if (!existingLedger.empty) {
        console.log(`⚠️ Duplicate deduction attempt: ${idempotencyKey}`);
        return { success: true, duplicate: true }; // Already processed
    }
    
    const userRef = db.collection('users').doc(userId);
    
    try {
        const result = await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            
            if (!userDoc.exists) {
                throw new Error('User not found');
            }
            
            const currentBalance = userDoc.data().credits_balance || 0;
            
            if (currentBalance < amount) {
                throw new Error('Insufficient credits');
            }
            
            const newBalance = currentBalance - amount;
            
            // Update balance atomically
            transaction.update(userRef, { credits_balance: newBalance });
            
            // Add ledger entry within same transaction
            const ledgerRef = db.collection('credits_ledger').doc();
            transaction.set(ledgerRef, {
                userId,
                amount: -amount,
                type: 'deduction',
                description,
                idempotencyKey,
                paypalEventId: null,
                balanceAfter: newBalance,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            return { newBalance };
        });
        
        console.log(`💳 Deducted ${amount} credit(s) from user ${userId}. New balance: ${result.newBalance}`);
        return { success: true, newBalance: result.newBalance };
        
    } catch (error) {
        console.error(`Failed to deduct credits for ${userId}:`, error.message);
        return { success: false, error: error.message };
    }
};

// Add credits atomically (for purchases, refunds, grants)
const addCredits = async (userId, amount, type, description, idempotencyKey, paypalEventId = null) => {
    if (!db) return { success: false, error: 'Database not initialized' };
    
    // Check idempotency first
    const existingLedger = await db.collection('credits_ledger')
        .where('idempotencyKey', '==', idempotencyKey)
        .limit(1)
        .get();
    
    if (!existingLedger.empty) {
        console.log(`⚠️ Duplicate credit addition attempt: ${idempotencyKey}`);
        return { success: true, duplicate: true };
    }
    
    const userRef = db.collection('users').doc(userId);
    
    try {
        const result = await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            
            let currentBalance = 0;
            let currentPlan = 'free';
            
            if (userDoc.exists) {
                currentBalance = userDoc.data().credits_balance || 0;
                currentPlan = userDoc.data().plan || 'free';
            }
            
            const newBalance = Math.max(0, currentBalance + amount); // Prevent negative on refunds
            
            // Update or create user
            if (userDoc.exists) {
                transaction.update(userRef, { 
                    credits_balance: newBalance,
                    plan: type === 'purchase' ? 'pro' : currentPlan
                });
            } else {
                transaction.set(userRef, {
                    plan: type === 'purchase' ? 'pro' : 'free',
                    credits_balance: newBalance,
                    paypalSubscriptionId: null,
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }
            
            // Add ledger entry
            const ledgerRef = db.collection('credits_ledger').doc();
            transaction.set(ledgerRef, {
                userId,
                amount,
                type,
                description,
                idempotencyKey,
                paypalEventId,
                balanceAfter: newBalance,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            return { newBalance };
        });
        
        console.log(`💰 Added ${amount} credit(s) to user ${userId} (${type}). New balance: ${result.newBalance}`);
        return { success: true, newBalance: result.newBalance };
        
    } catch (error) {
        console.error(`Failed to add credits for ${userId}:`, error.message);
        return { success: false, error: error.message };
    }
};

// Middleware to check credits before actions
const checkCredits = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || !db) {
        return next();
    }
    
    try {
        const idToken = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const userId = decodedToken.uid;
        
        const userData = await getCreditsBalance(userId);
        if (!userData) return next();
        
        if (userData.credits_balance <= 0) {
            return res.status(403).json({
                error: 'Insufficient credits',
                message: userData.plan === 'free' 
                    ? 'You have used all 3 free lifetime uploads. Upgrade to Pro for 40 uploads/month!' 
                    : 'You have no credits remaining. Your credits will renew with your next billing cycle.',
                credits_balance: userData.credits_balance,
                plan: userData.plan
            });
        }
        
        // Attach user data for later use
        req.creditsData = userData;
        req.user = decodedToken;
        next();
    } catch (error) {
        console.error('Error checking credits:', error);
        next();
    }
};

// --- 5. API ROUTES ---

app.post('/api/generate-plan', authenticate, upload.single('document'), async (req, res) => {
    // 1. Validation
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded or file too large (>5MB).' });
    }

    // 2. Pre-check credits before expensive AI call
    const userId = req.user.uid;
    if (db) {
        const userData = await getCreditsBalance(userId);
        if (!userData || userData.credits_balance <= 0) {
            await safeDelete(req.file.path);
            return res.status(403).json({
                error: 'Insufficient credits',
                message: userData?.plan === 'free' 
                    ? 'You have used all 3 free lifetime uploads. Upgrade to Pro for 40 uploads/month!' 
                    : 'You have no credits remaining. Your credits will renew with your next billing cycle.',
                credits_balance: userData?.credits_balance || 0,
                plan: userData?.plan || 'free'
            });
        }
    }

    console.log(`\n--- Processing: ${req.file.originalname} ---`);

    try {
        // 3. Extraction
        let documentText = await extractText(req.file);
        
        // Remove non-printable characters
        documentText = documentText.replace(/[\x00-\x09\x0B-\x0C\x0E-\x1F\x7F]/g, '');

        if (!documentText || documentText.trim().length < 50) {
            throw new Error("Document text is empty or too short. If this is a scanned PDF, try uploading the pages as images (PNG/JPG) for OCR processing.");
        }

        console.log(`Extracted ${documentText.length} characters.`);

        const truncatedText = documentText.substring(0, 40000); 

        // --- FETCH USER PREFERENCES ---
        let prefsPrompt = "";
        try {
            // Decoded token is available in req.user from auth middleware
            if (req.user && req.user.uid && db) {
                const userDoc = await db.collection('users').doc(req.user.uid).get();
                if (userDoc.exists) {
                    const userData = userDoc.data();
                    const p = userData.preferences;
                    
                    // --- FETCH MASTERY DATA ---
                    try {
                        const masterySnapshot = await db.collection('users').doc(req.user.uid).collection('mastery').get();
                        let masteryInfo = "";
                        masterySnapshot.forEach(doc => {
                            const m = doc.data();
                            masteryInfo += `- ${doc.id}: Score ${m.score}%, Level ${m.level}${m.unstable ? ' (UNSTABLE)' : ''}\n`;
                        });
                        
                        if (masteryInfo) {
                            prefsPrompt += `\nUSER MASTERY LEVELS:\n${masteryInfo}\nADAPTIVE INSTRUCTION: If a concept is UNSTABLE, provide simpler explanations and more worked examples. If Level is 3, provide harder edge cases.\n`;
                        }
                    } catch (mErr) {
                        console.warn("Failed to load mastery data:", mErr.message);
                    }

                    if (p) {
                         const toneMap = {
                            "neutral": "Maintain a neutral, academic tone.",
                            "motivational": "Use a highly motivational and encouraging tone. Use phrases like 'You got this!' and 'Keep going!'.",
                            "strict": "Use a strict, direct, and no-nonsense tone. Focus purely on efficiency.",
                            "friendly": "Use a friendly, casual, and approachable tone.",
                            "concise": "Be extremely concise. Use bullet points where possible and avoid fluff."
                        };
                        const toneInstruction = toneMap[p.tone] || toneMap["neutral"];
                        
                        const focusMap = {
                            "theory": "Prioritize deep theoretical understanding and definitions in the summary and concept map.",
                            "practice": "Prioritize practical applications, examples, and problem-solving strategies.",
                            "mixed": "Maintain a balance between theory and practice."
                        };
                        const focusInstruction = focusMap[p.focus_preference] || focusMap["mixed"];

                        const paceMap = {
                            "relaxed": "For the spaced repetition schedule, keep it light and manageable.",
                            "intensive": "For the questions and schedule, imply a rigorous and intensive study pace.",
                            "balanced": ""
                        };
                        const paceInstruction = paceMap[p.pace] || "";

                        prefsPrompt = `
CUSTOMIZATION SETTINGS:
- TONE: ${toneInstruction}
- FOCUS: ${focusInstruction}
- ${paceInstruction}
${p.difficulty_adaptation ? "- ADAPTATION: The questions should challenge the user based on the content complexity." : ""}
`;
                        console.log(`🎨 Applying styles: Tone=${p.tone}, Focus=${p.focus_preference}`);
                    }
                }
            }
        } catch (prefErr) {
            console.warn("Failed to load preferences for generation logic:", prefErr.message);
        }

        // 4. COST-EFFICIENT SINGLE-PASS PROMPT
        // Requests all deliverables in one atomic operation to minimize request overhead
        const systemPrompt = `You are an expert AI Study Assistant.
Analyze the text and generate a structured study plan with enhanced educational features.

${prefsPrompt}

GOALS:
1. SUMMARY: Executive summary with **bold** key terms (MAX 250 words).
2. LEARNING OBJECTIVES: 3-5 clear, extremely concise one-sentence goals using verbs like: define, apply, compute.
3. MEMORY PALACE: A vivid spatial mnemonic (MAX 100 words). Use **bold** for key anchor points (the locations or items in the room).
4. WORKED EXAMPLES: Provide 2 high-quality examples max. Each must be formatted as: Given data, Step-by-step reasoning, and Final result.
5. COMMON MISTAKES: Identify 2-3 common student errors for each topic based on the content.
6. ACTIVE RECALL: Generate 5 quiz questions max (multiple choice or short answer). 
   - Questions must be tiered in three levels: 
     Level 1: core definitions / recognition
     Level 2: standard application / practice
     Level 3: edge cases or advanced scenarios
   - Identify the "related_concept" for each question.
   - For multiple_choice, provide 4 options.
7. SPACED REPETITION: 4-step schedule (Day 1,3,7,14) with topic + optional hint.
8. CONCEPT MAP: Hierarchical tree with 1 main topic and 3-5 subtopics.

CONSTRAINTS:
- Use valid JSON only.
- Snake_case keys.
- NO extra text.
- Do NOT reveal common mistakes upfront in the summary; put them only in the common_mistakes array.
- Keep the total response UNDER 2000 tokens.

SCHEMA:
{
  "summary": "string (html permitted)",
  "learning_objectives": ["string", "string"],
  "memory_palace": "string",
  "worked_examples": [{ "subtopic": "string", "given_data": "string", "step_by_step_reasoning": ["step 1", "step 2"], "final_result": "string" }],
  "common_mistakes": [{ "mistake": "string", "explanation": "string", "related_concept": "string" }],
  "active_recall": [{ 
    "question": "string", 
    "answer": "string", 
    "level": 1-3, 
    "type": "multiple_choice" | "short_answer",
    "options": ["string", "string", "string", "string"],
    "related_concept": "string",
    "difficulty_rating": 1-5  // REQUIRED: Rating from 1 (easiest) to 5 (hardest)
  }],
  "spaced_repetition": [{ "day": "string", "topic": "string", "hint": "string"}],
  "concept_map": { "main_topic": "string", "subtopics": ["string", "string", "string"] }
}
MUST: Ensure difficulty_rating is ALWAYS present for every active_recall item.`;

        console.log('Sending single optimized request to Perplexity AI...');
        
        // Single call using standard 'sonar' model for cost efficiency
        const response = await axios.post('https://api.perplexity.ai/chat/completions', {
            model: 'sonar', // Cheaper than sonar-pro
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Analyze this material:\n\n${truncatedText}` }
            ],
            temperature: 0.1,
            max_tokens: 4000
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 60000
        });

        // 5. Response Handling
        let content = response.data?.choices?.[0]?.message?.content;
        
        if (!content) throw new Error("AI response was empty.");
        
        // Clean markdown wrapper and extract JSON
        content = content.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        
        // More robust JSON extraction
        const firstBrace = content.indexOf('{');
        const lastBrace = content.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) {
            content = content.substring(firstBrace, lastBrace + 1);
        }

        let studyPlan;
        try {
            studyPlan = JSON.parse(content);
            
            // --- 5a. ZOD VALIDATION ---
            // Validate the structure before processing/saving
            try {
                studyPlan = StudyPlanSchema.parse(studyPlan);
            } catch (validationError) {
                console.error("Zod Validation Error:", validationError.errors);
                // Attempt to return partial/invalid plan is dangerous, so we throw
                throw new Error("AI generated invalid plan structure: " + JSON.stringify(validationError.errors));
            }

            // --- VALIDATION & DEFAULTS ---
            if (!studyPlan.summary) studyPlan.summary = "Summary not generated.";
            
            // Validate Arrays
            studyPlan.learning_objectives = Array.isArray(studyPlan.learning_objectives) ? studyPlan.learning_objectives : [];
            studyPlan.worked_examples = Array.isArray(studyPlan.worked_examples) ? studyPlan.worked_examples : [];
            studyPlan.common_mistakes = Array.isArray(studyPlan.common_mistakes) ? studyPlan.common_mistakes : [];

            studyPlan.active_recall = Array.isArray(studyPlan.active_recall) ? studyPlan.active_recall.map((q, i) => ({
                question: q.question || `Question ${i+1}`,
                answer: q.answer || "Check your notes",
                difficulty_rating: q.difficulty_rating || 3,
                level: q.level || 1,
                type: q.type || "short_answer",
                options: q.options || [],
                related_concept: q.related_concept || "General"
            })) : [];

            studyPlan.spaced_repetition = Array.isArray(studyPlan.spaced_repetition) ? studyPlan.spaced_repetition.map(s => ({
                day: s.day || "Day 1",
                topic: s.topic || "General Review",
                hint: s.hint || null
            })) : [];

            // Handle new hierarchical format or convert old array format
            if (studyPlan.concept_map && typeof studyPlan.concept_map === 'object' && !Array.isArray(studyPlan.concept_map)) {
                // New format: { main_topic, subtopics }
                studyPlan.concept_map = {
                    main_topic: studyPlan.concept_map.main_topic || "Main Topic",
                    subtopics: Array.isArray(studyPlan.concept_map.subtopics) ? studyPlan.concept_map.subtopics : []
                };
            } else if (Array.isArray(studyPlan.concept_map)) {
                // Old format: convert array to hierarchical structure
                const concepts = studyPlan.concept_map.map(c => c.concept || "Concept");
                studyPlan.concept_map = {
                    main_topic: concepts[0] || "Main Topic",
                    subtopics: concepts.slice(1)
                };
            } else {
                studyPlan.concept_map = { main_topic: "Main Topic", subtopics: [] };
            }

        } catch (jsonError) {
            console.error("JSON Parse Error:", jsonError.message);
            throw new Error("Failed to parse AI response.");
        }

        console.log('✅ Plan generated successfully!');

        // 6. Save to Firestore (user is authenticated via middleware)
        if (db) {
            const docRef = await db.collection('generations').add({
                userId: userId,
                fileName: req.file.originalname,
                studyPlan: studyPlan,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            // Save to disk using the Firestore ID as filename (Optional backup)
            try {
                 await savePlanToFile(userId, docRef.id, studyPlan);
            } catch (diskErr) {
                console.warn("Failed to save backup to disk (non-critical):", diskErr.message);
            }
            
            // Deduct credits atomically (idempotency key = generation ID)
            const deductResult = await deductCredits(
                userId, 
                1, 
                `Study plan generation: ${req.file.originalname}`,
                `gen_${docRef.id}`
            );
            
            // Fail fast: if credit deduction fails, delete the generation and return error
            if (!deductResult.success && !deductResult.duplicate) {
                console.error('⚠️ Credit deduction failed after generation:', deductResult.error);
                await docRef.delete().catch(() => {});
                return res.status(402).json({ 
                    error: 'Credit deduction failed', 
                    message: 'Unable to process credits. Please try again.' 
                });
            }
            
            console.log('💾 Plan saved to Firestore for user:', userId);
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

// --- HISTORY ENDPOINT ---
app.get('/api/history', authenticate, async (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not initialized' });
    }

    try {
        const userId = req.user.uid;
        console.log(`[HISTORY] Fetching for user: ${userId}`);
        
        const snapshot = await db.collection('generations')
            .where('userId', '==', userId)
            .limit(40)
            .get();

        const history = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            
            // Robust date handling
            let createdAtDate;
            if (data.createdAt && typeof data.createdAt.toDate === 'function') {
                createdAtDate = data.createdAt.toDate();
            } else if (data.createdAt) {
                createdAtDate = new Date(data.createdAt);
            } else {
                createdAtDate = new Date();
            }

            history.push({
                id: doc.id,
                title: data.fileName || 'Untitled Study Session',
                createdAt: createdAtDate,
                topic: data.studyPlan?.concept_map?.main_topic || 'General Study' 
            });
        });

        // Safe sort
        history.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        res.json(history.slice(0, 20));
    } catch (error) {
        console.error('[HISTORY ERROR]:', error);
        res.status(500).json({ error: 'Failed to fetch history', details: error.message });
    }
});

// --- AI CHAT ENDPOINTS ---

// Get chat history for a specific study plan
app.get('/api/chat/:generationId', authenticate, async (req, res) => {
    if (!db) return res.status(500).json({ error: 'Database not initialized' });
    
    try {
        const { generationId } = req.params;
        const userId = req.user.uid;

        const doc = await db.collection('conversations').doc(`${userId}_${generationId}`).get();
        if (!doc.exists) {
            return res.json({ messages: [] });
        }

        res.json(doc.data());
    } catch (error) {
        console.error('Error fetching chat history:', error);
        res.status(500).json({ error: 'Failed to fetch history' });
    }
});

// Save/Update chat history
app.post('/api/chat/:generationId', authenticate, async (req, res) => {
    if (!db) return res.status(500).json({ error: 'Database not initialized' });
    
    try {
        const { generationId } = req.params;
        const { messages } = req.body;
        const userId = req.user.uid;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'Messages array required' });
        }

        await db.collection('conversations').doc(`${userId}_${generationId}`).set({
            userId,
            generationId,
            messages,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        res.json({ success: true });
    } catch (error) {
        console.error('Error saving chat history:', error);
        res.status(500).json({ error: 'Failed to save history' });
    }
});

// --- QUIZ & MASTERY ENDPOINTS ---

app.post('/api/quiz/submit', authenticate, async (req, res) => {
    if (!db) return res.status(500).json({ error: 'Database not initialized' });

    try {
        const { generationId, questionIndex, userAnswer, isCorrect } = req.body;
        const userId = req.user.uid;

        if (generationId === undefined || questionIndex === undefined) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // 1. Fetch the generation to get the question details
        const genDoc = await db.collection('generations').doc(generationId).get();
        if (!genDoc.exists || genDoc.data().userId !== userId) {
            return res.status(404).json({ error: 'Study plan not found' });
        }

        const studyPlan = genDoc.data().studyPlan;
        const question = studyPlan.active_recall[questionIndex];

        if (!question) {
            return res.status(400).json({ error: 'Invalid question index' });
        }

        const concept = question.related_concept || 'General';
        
        // 2. Update Mastery Score
        const masteryRef = db.collection('users').doc(userId).collection('mastery').doc(concept);
        const masteryDoc = await masteryRef.get();
        
        let masteryData = masteryDoc.exists ? masteryDoc.data() : { 
            score: 50, 
            level: 1, 
            history: [], 
            lastUpdated: null 
        };

        // Weighted update (more weight to recent answers)
        const weight = 0.3;
        const resultValue = isCorrect ? 100 : 0;
        masteryData.score = Math.round((masteryData.score * (1 - weight)) + (resultValue * weight));
        
        // Mark instability
        if (!isCorrect) {
            masteryData.unstable = true;
            masteryData.consecutive_failures = (masteryData.consecutive_failures || 0) + 1;
        } else {
            masteryData.unstable = false;
            masteryData.consecutive_failures = 0;
        }

        // Promote/Demote level based on score thresholds
        if (masteryData.score > 85 && masteryData.level < 3) masteryData.level++;
        if (masteryData.score < 40 && masteryData.level > 1) masteryData.level--;

        masteryData.history.push({
            isCorrect,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            generationId
        });
        
        // Keep history sane
        if (masteryData.history.length > 20) masteryData.history.shift();
        
        masteryData.lastUpdated = admin.firestore.FieldValue.serverTimestamp();

        await masteryRef.set(masteryData);

        // 3. Escalation Path logic (if failures >= 3)
        let escalation = null;
        if (masteryData.consecutive_failures >= 3) {
            escalation = {
                message: "You've struggled with this concept recently. Let's try a different approach.",
                action: "ADD_WORKED_EXAMPLE",
                scope_reduction: true
            };
        }

        // 4. Schedule Integration (Incorrect answers -> reschedule sooner)
        if (!isCorrect) {
            // Find related topic in schedule and move it to "Tomorrow" or similar
            // For simplicity, we just flag the generation for review
            await db.collection('generations').doc(generationId).update({
                'studyPlan.needs_review': true,
                'studyPlan.last_failed_concept': concept
            });
        }

        res.json({
            success: true,
            masteryScore: masteryData.score,
            level: masteryData.level,
            unstable: masteryData.unstable,
            escalation
        });

    } catch (error) {
        console.error('Error submitting quiz result:', error);
        res.status(500).json({ error: 'Failed to process quiz result' });
    }
});

app.get('/api/mastery', authenticate, async (req, res) => {
    if (!db) return res.status(500).json({ error: 'Database not initialized' });

    try {
        const userId = req.user.uid;
        const snapshot = await db.collection('users').doc(userId).collection('mastery').get();
        
        const mastery = {};
        snapshot.forEach(doc => {
            mastery[doc.id] = doc.data();
        });

        res.json(mastery);
    } catch (error) {
        console.error('Error fetching mastery:', error);
        res.status(500).json({ error: 'Failed to fetch mastery data' });
    }
});
app.post('/api/chat', authenticate, async (req, res) => {
    // Basic validation
    if (!req.body.messages || !Array.isArray(req.body.messages)) {
        return res.status(400).json({ error: 'Messages array is required.' });
    }

    const userId = req.user.uid;

    try {
        // 1. Rate Limiting (20 msgs/hour)
        const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
        const rateLimitSnapshot = await db.collection('credits_ledger')
            .where('userId', '==', userId)
            .where('type', '==', 'deduction')
            .where('description', '==', 'AI Chat Interaction')
            .where('createdAt', '>=', hourAgo)
            .get();

        if (rateLimitSnapshot.size >= 20) {
            return res.status(429).json({ 
                error: 'Rate limit exceeded', 
                message: 'You can only send 20 messages per hour. Please wait a while.' 
            });
        }

        // 2. Credit Deduction
        const deductResult = await deductCredits(userId, 1, 'AI Chat Interaction');
        if (!deductResult.success) {
            return res.status(403).json({ 
                error: 'Insufficient credits', 
                message: deductResult.message 
            });
        }

        console.log(`💬 Chat request: user ${userId}, remaining credits: ${deductResult.newBalance}`);

        // 3. AI Provider Request
        // Sanitize messages: ensure they have role and content, and are strings
        const validatedMessages = req.body.messages
            .filter(m => m.role && m.content)
            .map(m => ({
                role: String(m.role),
                content: String(m.content)
            }));

        if (validatedMessages.length === 0) {
            return res.status(400).json({ error: 'No valid messages provided.' });
        }

        const response = await axios.post('https://api.perplexity.ai/chat/completions', {
            model: 'sonar',
            messages: validatedMessages,
            temperature: 0.7 
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 60000
        });

        const aiMessage = response.data?.choices?.[0]?.message;
        if (!aiMessage) {
            console.error('AI Provider Error: Empty response choices', response.data);
            throw new Error('No response from AI provider');
        }

        res.json({
            ...aiMessage,
            creditsRemaining: deductResult.newBalance
        });

    } catch (error) {
        console.error('❌ Chat API Error:', error.message);
        
        // Detailed error forwarding
        if (error.response) {
            const status = error.response.status;
            const data = error.response.data;
            console.error(`AI Provider (${status}):`, JSON.stringify(data));
            
            return res.status(status).json({ 
                error: 'AI Provider Error', 
                message: data.error?.message || 'The AI provider returned an error.',
                details: data
            });
        }
        
        res.status(500).json({ error: 'Failed to process chat request', details: error.message });
    }
});

// --- 6. CREDITS ENDPOINTS ---

// Get current user's credits balance
app.get('/api/credits/balance', authenticate, async (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Firestore not initialized' });
    }

    try {
        const userData = await getCreditsBalance(req.user.uid);
        if (!userData) {
            return res.status(500).json({ error: 'Could not fetch credits data' });
        }
        
        res.json({
            plan: userData.plan,
            credits_balance: userData.credits_balance,
            plan_credits: PLAN_CREDITS[userData.plan] || PLAN_CREDITS.free
        });
    } catch (error) {
        console.error('Error fetching credits:', error);
        res.status(500).json({ error: error.message });
    }
});

// Legacy endpoint for backwards compatibility (maps to new credits system)
app.get('/api/usage', authenticate, async (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Firestore not initialized' });
    }

    try {
        const userData = await getCreditsBalance(req.user.uid);
        if (!userData) {
            return res.status(500).json({ error: 'Could not fetch usage data' });
        }
        
        const limit = PLAN_CREDITS[userData.plan] || PLAN_CREDITS.free;
        
        res.json({
            plan: userData.plan,
            uploadsThisMonth: limit - userData.credits_balance, // Backwards compatible
            limit: limit,
            remaining: userData.credits_balance,
            credits_balance: userData.credits_balance
        });
    } catch (error) {
        console.error('Error fetching usage:', error);
        res.status(500).json({ error: error.message });
    }
});

// PayPal Webhook handler with signature verification and idempotency
app.post('/api/paypal/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        // Parse the webhook body
        const rawBody = req.body;
        const event = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
        const eventId = event.id;
        
        console.log(`📬 PayPal Webhook received: ${event.event_type} (ID: ${eventId})`);
        
        if (!db) {
            console.error('Firestore not initialized, cannot process webhook');
            return res.status(200).send('OK');
        }
        
        // 1. Verify webhook signature (production requirement)
        const isValid = await verifyPayPalWebhook(req.headers, event);
        if (!isValid) {
            console.error('❌ PayPal webhook signature verification failed');
            return res.status(401).send('Invalid signature');
        }
        
        // 2. Check if already processed (idempotency)
        if (await isWebhookProcessed(eventId)) {
            console.log(`⚠️ Webhook ${eventId} already processed, skipping`);
            return res.status(200).send('OK');
        }
        
        const subscriptionId = event.resource?.id;
        const customId = event.resource?.custom_id; // User ID from PayPal
        
        // 3. Process event based on type
        switch (event.event_type) {
            case 'BILLING.SUBSCRIPTION.ACTIVATED':
            case 'PAYMENT.SALE.COMPLETED':
                // Add credits for new subscription or renewal payment
                if (subscriptionId) {
                    // Find user by subscription ID or custom_id
                    let userId = customId;
                    
                    if (!userId) {
                        const snapshot = await db.collection('users')
                            .where('paypalSubscriptionId', '==', subscriptionId)
                            .limit(1)
                            .get();
                        
                        if (!snapshot.empty) {
                            userId = snapshot.docs[0].id;
                        }
                    }
                    
                    if (userId) {
                        // Add Pro credits
                        const result = await addCredits(
                            userId,
                            PLAN_CREDITS.pro,
                            'purchase',
                            `Pro subscription payment (${event.event_type})`,
                            `paypal_${eventId}`,
                            eventId
                        );
                        
                        // Update subscription ID on user
                        await db.collection('users').doc(userId).update({
                            paypalSubscriptionId: subscriptionId,
                            plan: 'pro'
                        });
                        
                        console.log(`🎉 Credits added for user ${userId}: ${PLAN_CREDITS.pro}`);
                    } else {
                        console.warn(`⚠️ No user found for subscription: ${subscriptionId}`);
                    }
                }
                break;
                
            case 'PAYMENT.SALE.REFUNDED':
            case 'PAYMENT.SALE.REVERSED':
                // Subtract credits for refunds
                if (subscriptionId) {
                    const snapshot = await db.collection('users')
                        .where('paypalSubscriptionId', '==', subscriptionId)
                        .limit(1)
                        .get();
                    
                    if (!snapshot.empty) {
                        const userId = snapshot.docs[0].id;
                        
                        // Subtract credits (use negative amount in addCredits)
                        await addCredits(
                            userId,
                            -PLAN_CREDITS.pro,
                            'refund',
                            `Payment refunded/reversed (${event.event_type})`,
                            `paypal_refund_${eventId}`,
                            eventId
                        );
                        
                        console.log(`💸 Credits refunded for user ${userId}`);
                    }
                }
                break;
                
            case 'BILLING.SUBSCRIPTION.CANCELLED':
            case 'BILLING.SUBSCRIPTION.SUSPENDED':
            case 'BILLING.SUBSCRIPTION.EXPIRED':
                // Downgrade user to free (don't remove credits, just change plan)
                if (subscriptionId) {
                    const snapshot = await db.collection('users')
                        .where('paypalSubscriptionId', '==', subscriptionId)
                        .limit(1)
                        .get();
                    
                    if (!snapshot.empty) {
                        const userDoc = snapshot.docs[0];
                        await userDoc.ref.update({
                            plan: 'free',
                            subscriptionCancelledAt: admin.firestore.FieldValue.serverTimestamp()
                        });
                        console.log(`📉 User ${userDoc.id} downgraded to Free (${event.event_type})`);
                    }
                }
                break;
                
            default:
                console.log(`ℹ️ Unhandled PayPal event: ${event.event_type}`);
        }
        
        // 4. Mark webhook as processed
        await markWebhookProcessed(eventId, event.event_type);
        
        res.status(200).send('OK');
    } catch (error) {
        console.error('Error processing PayPal webhook:', error);
        res.status(200).send('OK'); // Always return 200 to avoid retries
    }
});

// --- 7. HISTORY ROUTE ---

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

        // 1. Plan A: Check if studyPlan is in Firestore (New records)
        if (data.studyPlan) {
             return res.json({ id: doc.id, ...data });
        }

        // 2. Plan B: Check disk (Legacy records)
        const filePath = path.join(__dirname, 'saved_plans', req.user.uid, `${doc.id}.json`);
        
        try {
            const fileContent = await fsPromises.readFile(filePath, 'utf-8');
            const studyPlan = JSON.parse(fileContent);
            
            // Self-repair: Save back to Firestore for future
            doc.ref.update({ studyPlan }).catch(err => console.warn("Failed to migrate legacy plan to Firestore:", err));

            res.json({ id: doc.id, ...data, studyPlan });
        } catch (fileError) {
            console.error('Error reading saved plan file:', fileError.message);
            res.status(404).json({ error: 'Plan content missing. It may have been lost due to server restart.' });
        }
    } catch (error) {
        console.error('Error fetching generation:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update a specific generation's study plan
app.put('/api/generations/:id', authenticate, async (req, res) => {
    if (!db) return res.status(500).json({ error: 'Firestore not initialized' });

    try {
        const doc = await db.collection('generations').doc(req.params.id).get();
        if (!doc.exists || doc.data().userId !== req.user.uid) {
            return res.status(404).json({ error: 'Generation not found' });
        }

        const { studyPlan } = req.body;
        if (!studyPlan) {
            return res.status(400).json({ error: 'Study plan data required' });
        }

        // Validate structure with Zod
        const result = StudyPlanSchema.safeParse(studyPlan);
        if (!result.success) {
            return res.status(400).json({ 
                error: 'Invalid study plan structure', 
                details: result.error.errors 
            });
        }
        
        // Use the validated data
        const validatedPlan = result.data;

        // 1. Update Firestore
        await doc.ref.update({
            studyPlan: validatedPlan,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // 2. Update disk (Backup/Legacy compatibility)
        try {
            const filePath = path.join(__dirname, 'saved_plans', req.user.uid, `${doc.id}.json`);
             await fsPromises.writeFile(filePath, JSON.stringify(studyPlan, null, 2));
        } catch (diskErr) {
            console.warn("Failed to update disk backup (non-critical):", diskErr.message);
        }

        console.log(`📝 Plan ${doc.id} updated by user ${req.user.uid}`);
        res.json({ message: 'Plan updated successfully' });
    } catch (error) {
        console.error('Error updating generation:', error);
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

// --- 7. STUDY PREFERENCES ---

// Get User Preferences
app.get('/api/preferences', authenticate, async (req, res) => {
    if (!db) return res.status(500).json({ error: 'Firestore not initialized' });

    try {
        const userDoc = await db.collection('users').doc(req.user.uid).get();
        if (!userDoc.exists) {
            // Return defaults if user doesn't exist (shouldn't happen for auth'd users usually, but safe fallback)
            return res.json({
                tone: "neutral",
                difficulty_adaptation: true,
                pace: "balanced",
                reminder_frequency: "medium",
                focus_preference: "mixed"
            });
        }

        const data = userDoc.data();
        const preferences = data.preferences || {
            tone: "neutral",
            difficulty_adaptation: true,
            pace: "balanced",
            reminder_frequency: "medium",
            focus_preference: "mixed"
        };

        res.json(preferences);
    } catch (error) {
        console.error('Error fetching preferences:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update User Preferences
app.put('/api/preferences', authenticate, async (req, res) => {
    if (!db) return res.status(500).json({ error: 'Firestore not initialized' });

    try {
        const { tone, difficulty_adaptation, pace, reminder_frequency, focus_preference } = req.body;
        
        // Construct preferences object with validation/defaults
        const preferences = {
            tone: tone || "neutral",
            difficulty_adaptation: difficulty_adaptation ?? true,
            pace: pace || "balanced",
            reminder_frequency: reminder_frequency || "medium",
            focus_preference: focus_preference || "mixed"
        };

        await db.collection('users').doc(req.user.uid).set({
            preferences: preferences
        }, { merge: true });

        console.log(`Updated preferences for user: ${req.user.uid}`);
        res.json({ message: 'Preferences updated successfully', preferences });
    } catch (error) {
        console.error('Error updating preferences:', error);
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

// Only start server if run directly (not imported)
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`------------------------------------------------`);
        console.log(`🚀 GoStudy Backend running on port ${PORT}`);
        console.log(`------------------------------------------------`);
    });
}

module.exports = app;