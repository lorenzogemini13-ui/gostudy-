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
    
    return { ...userDoc.data(), id: userId };
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

// Only start server if run directly (not imported)
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`------------------------------------------------`);
        console.log(`🚀 GoStudy Backend running on port ${PORT}`);
        console.log(`------------------------------------------------`);
    });
}

module.exports = app;