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
        console.warn('⚠️ PayPal credentials not configured, skipping webhook verification');
        return true; // Skip verification in dev
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

app.post('/api/generate-plan', checkCredits, upload.single('document'), async (req, res) => {
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

        const truncatedText = documentText.substring(0, 40000); 

        // --- FETCH USER PREFERENCES ---
        let prefsPrompt = "";
        try {
            // Decoded token is available in req.user from auth middleware
            if (req.user && req.user.uid && db) {
                const userDoc = await db.collection('users').doc(req.user.uid).get();
                if (userDoc.exists) {
                    const p = userDoc.data().preferences;
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
Analyze the text and generate a structured study plan.

${prefsPrompt}

GOALS:
1. SUMMARY: Executive summary with **bold** key terms (MAX 250 words).
2. MEMORY PALACE: A vivid spatial mnemonic (MAX 100 words).
3. ACTIVE RECALL: 5 questions (difficulty 1-5).
4. SPACED REPETITION: 4-step schedule (Day 1,3,7,14) with topic + optional hint.
5. CONCEPT MAP: Hierarchical tree with 1 main topic and 3-5 subtopics branching from it.

CONSTRAINTS:
- Use valid JSON only.
- Snake_case keys.
- NO extra text.

SCHEMA:
{
  "summary": "string (html permitted)",
  "memory_palace": "string",
  "active_recall": [{ "question": "string", "answer": "string", "difficulty_rating": 1-5 }],
  "spaced_repetition": [{ "day": "string", "topic": "string", "hint": "string"}],
  "concept_map": { "main_topic": "string", "subtopics": ["string", "string", "string"] }
}`;

        console.log('Sending single optimized request to Perplexity AI...');
        
        // Single call using standard 'sonar' model for cost efficiency
        const response = await axios.post('https://api.perplexity.ai/chat/completions', {
            model: 'sonar', // Cheaper than sonar-pro
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Analyze this material:\n\n${truncatedText}` }
            ],
            temperature: 0.2,
            max_tokens: 3000
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
        
        // Clean markdown wrapper
        content = content.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) content = jsonMatch[0];

        let studyPlan;
        try {
            studyPlan = JSON.parse(content);
            
            // --- VALIDATION & DEFAULTS ---
            if (!studyPlan.summary) studyPlan.summary = "Summary not generated.";
            
            // Validate Arrays
            studyPlan.active_recall = Array.isArray(studyPlan.active_recall) ? studyPlan.active_recall.map((q, i) => ({
                question: q.question || `Question ${i+1}`,
                answer: q.answer || "Check your notes",
                difficulty_rating: q.difficulty_rating || 3
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

        // 6. Save to Firestore if user is authenticated
        if (req.headers.authorization && db) {
            try {
                const authHeader = req.headers.authorization;
                const idToken = authHeader.split('Bearer ')[1];
                const decodedToken = await admin.auth().verifyIdToken(idToken);
                
                // DATA PERSISTENCE FIX: Save studyPlan directly to Firestore
                const docRef = await db.collection('generations').add({
                    userId: decodedToken.uid,
                    fileName: req.file.originalname,
                    studyPlan: studyPlan, // <--- Save full plan here
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
                
                // Save to disk using the Firestore ID as filename (Optional backup)
                try {
                     await savePlanToFile(decodedToken.uid, docRef.id, studyPlan);
                } catch (diskErr) {
                    console.warn("Failed to save backup to disk (non-critical):", diskErr.message);
                }
                
                // Deduct credits atomically (idempotency key = generation ID)
                const deductResult = await deductCredits(
                    decodedToken.uid, 
                    1, 
                    `Study plan generation: ${req.file.originalname}`,
                    `gen_${docRef.id}`
                );
                
                if (!deductResult.success && !deductResult.duplicate) {
                    console.error('⚠️ Credit deduction failed after generation:', deductResult.error);
                }
                
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

        // Validate structure
        const requiredFields = ['summary', 'concept_map', 'active_recall', 'spaced_repetition', 'memory_palace'];
        for (const field of requiredFields) {
            if (studyPlan[field] === undefined) {
                return res.status(400).json({ error: `Missing required field: ${field}` });
            }
        }

        // 1. Update Firestore
        await doc.ref.update({
            studyPlan: studyPlan,
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